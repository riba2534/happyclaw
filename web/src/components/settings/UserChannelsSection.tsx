import { FeishuChannelCard } from './FeishuChannelCard';
import { TelegramChannelCard } from './TelegramChannelCard';
import { QQChannelCard } from './QQChannelCard';
import { WeChatChannelCard } from './WeChatChannelCard';
import { DingTalkChannelCard } from './DingTalkChannelCard';
import { DiscordChannelCard } from './DiscordChannelCard';

export function UserChannelsSection() {
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground bg-muted rounded-lg px-4 py-3">
        绑定你的 IM 账号，消息将发送到你的主工作区。
      </p>
      <FeishuChannelCard />
      <TelegramChannelCard />
      <QQChannelCard />
      <WeChatChannelCard />
      <DingTalkChannelCard />
      <DiscordChannelCard />
    </div>
  );
}
