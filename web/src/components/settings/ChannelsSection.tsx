import type { SettingsNotification } from './types';
import { FeishuConfigForm } from './FeishuConfigForm';
import { TelegramConfigForm } from './TelegramConfigForm';

interface ChannelsSectionProps extends SettingsNotification {}

export function ChannelsSection({ setNotice, setError }: ChannelsSectionProps) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-500 bg-slate-50 rounded-lg px-4 py-3">
        管理系统级 IM 渠道凭据，此处配置作为全局默认，影响所有未单独配置的用户。
      </p>
      <FeishuConfigForm setNotice={setNotice} setError={setError} />
      <TelegramConfigForm setNotice={setNotice} setError={setError} />
    </div>
  );
}
