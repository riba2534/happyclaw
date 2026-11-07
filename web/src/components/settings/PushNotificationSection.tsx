import type { ReactNode } from 'react';
import { BellOff, Loader2, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  usePushNotifications,
  type PushNotificationsApi,
  type PushStatus,
} from '../../hooks/usePushNotifications';
import { useIsGuest } from '../../stores/auth';
import { SettingsGroup, SettingsSection } from './SettingsLayout';
import { SettingsSwitchRow } from './SettingsFormControls';

const STATUS_LABEL: Record<PushStatus, string> = {
  checking: '检查中',
  unsupported: '不支持',
  'needs-install': '需先添加到主屏幕',
  unavailable: '不可用',
  denied: '被拒绝',
  off: '未开启',
  on: '已开启',
};

function describe(status: PushStatus): ReactNode {
  switch (status) {
    case 'checking':
      return '正在检查当前设备的推送状态…';
    case 'unsupported':
      return '当前浏览器不支持推送通知。可改用较新的 Chrome、Edge、Firefox 或 Safari。';
    case 'needs-install':
      return (
        <>
          <span className="block text-warning">需先添加到主屏幕</span>
          iPhone 和 iPad 只有添加到主屏幕的应用才能接收推送：在 Safari
          点「分享」→「添加到主屏幕」，再从主屏幕图标打开
          HappyClaw，回到这里开启。
        </>
      );
    case 'unavailable':
      return '服务器暂时无法提供推送通知，请稍后重试。';
    case 'denied':
      return (
        <>
          <span className="block text-warning">当前设备已拒绝通知权限</span>
          请在系统或浏览器的网站设置中允许 HappyClaw 发送通知，然后刷新页面。
        </>
      );
    default:
      return '应用在后台或已关闭时，回复完成或运行出错也会发系统通知，并更新应用角标。正在查看的会话不会重复提醒。';
  }
}

function Control({
  push,
}: {
  push: Pick<PushNotificationsApi, 'status' | 'busy' | 'enable' | 'disable'>;
}) {
  const { status, busy } = push;
  if (status === 'checking' || busy) {
    return <Loader2 className="size-4 animate-spin text-faint-foreground" />;
  }
  if (status === 'off' || status === 'on') {
    return (
      <Switch
        id="push-notifications"
        checked={status === 'on'}
        // enable() must start its subscribe call inside this handler.
        onCheckedChange={(next) => void (next ? push.enable() : push.disable())}
      />
    );
  }
  return (
    <BellOff
      className={
        status === 'denied' || status === 'needs-install'
          ? 'size-4 text-warning'
          : 'size-4 text-faint-foreground'
      }
    />
  );
}

/**
 * Settings → Preferences: Web Push for this device. Guests have no push, so
 * for them nothing is shown and nothing is requested.
 */
export function PushNotificationSection() {
  const isGuest = useIsGuest();
  return isGuest ? null : <PushNotificationSettings />;
}

function PushNotificationSettings() {
  const push = usePushNotifications();
  const { status, busy, error, testResult, sendTest } = push;

  return (
    <SettingsSection
      title="推送通知"
      description="当前设备：应用在后台或关闭时，通过系统推送提醒你"
    >
      <SettingsGroup>
        <SettingsSwitchRow
          label={`推送通知 · ${STATUS_LABEL[status]}`}
          htmlFor={
            status === 'on' || status === 'off'
              ? 'push-notifications'
              : undefined
          }
          description={describe(status)}
          control={<Control push={push} />}
        />
        {status === 'on' && (
          <SettingsSwitchRow
            label="发送测试通知"
            description={
              testResult === 'sent'
                ? '已发送，稍等片刻应当收到一条通知。'
                : testResult === 'failed'
                  ? '没有发送成功，请稍后重试。'
                  : '向你账号下已开启推送的设备发一条测试通知。'
            }
            control={
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void sendTest()}
              >
                <Send className="size-3.5" />
                发送
              </Button>
            }
          />
        )}
      </SettingsGroup>
      {error && <p className="text-caption text-error">{error}</p>}
    </SettingsSection>
  );
}
