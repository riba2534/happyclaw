import type { SettingsNotification } from './types';
import { FeishuChannelCard } from './FeishuChannelCard';
import { TelegramChannelCard } from './TelegramChannelCard';
import { QQChannelCard } from './QQChannelCard';

interface UserChannelsSectionProps extends SettingsNotification {}

export function UserChannelsSection({ setNotice, setError }: UserChannelsSectionProps) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-500 bg-slate-50 rounded-lg px-4 py-3">
        绑定你的 IM 账号，消息将发送到你的主工作区。
      </p>
      <FeishuChannelCard setNotice={setNotice} setError={setError} />
      <TelegramChannelCard setNotice={setNotice} setError={setError} />
      <QQChannelCard setNotice={setNotice} setError={setError} />
    </div>
  );
}
