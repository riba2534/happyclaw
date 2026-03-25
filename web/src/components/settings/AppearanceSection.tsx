import { useEffect, useState } from 'react';
import { Loader2, Bot } from 'lucide-react';
import { toast } from 'sonner';

import { useAuthStore } from '../../stores/auth';
import { api } from '../../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { EmojiAvatar } from '@/components/common/EmojiAvatar';
import { EmojiPicker } from '@/components/common/EmojiPicker';
import { ColorPicker } from '@/components/common/ColorPicker';
import { getErrorMessage } from './types';
import { SettingsCard as Section } from './SettingsCard';
import type { AppearanceConfig } from '../../stores/auth';

export function AppearanceSection() {
  const { hasPermission } = useAuthStore();

  const [appName, setAppName] = useState('');
  const [aiName, setAiName] = useState('');
  const [aiAvatarEmoji, setAiAvatarEmoji] = useState('');
  const [aiAvatarColor, setAiAvatarColor] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const canManage = hasPermission('manage_system_config');

  useEffect(() => {
    if (!canManage) { setLoading(false); return; }
    (async () => {
      setLoading(true);
      try {
        const data = await api.get<AppearanceConfig>('/api/config/appearance');
        setAppName(data.appName);
        setAiName(data.aiName);
        setAiAvatarEmoji(data.aiAvatarEmoji);
        setAiAvatarColor(data.aiAvatarColor);
      } catch (err) {
        toast.error(getErrorMessage(err, '加载外观配置失败'));
      } finally {
        setLoading(false);
      }
    })();
  }, [canManage]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const data = await api.put<AppearanceConfig>('/api/config/appearance', {
        appName: appName.trim() || undefined,
        aiName: aiName.trim(),
        aiAvatarEmoji,
        aiAvatarColor,
      });
      setAppName(data.appName);
      setAiName(data.aiName);
      setAiAvatarEmoji(data.aiAvatarEmoji);
      setAiAvatarColor(data.aiAvatarColor);
      useAuthStore.setState({ appearance: data });
      toast.success('外观设置已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存外观设置失败'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!canManage) {
    return <div className="text-sm text-muted-foreground">需要系统配置权限才能修改全局外观设置。</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground bg-muted rounded-lg px-4 py-3">
        全局默认值，对所有用户生效。用户可在「个人资料」中覆盖 AI 外观和主题偏好。
      </p>

      {/* ── AI Default Appearance ── */}
      <Section icon={Bot} title="AI 默认外观" desc="所有用户看到的默认 AI 助手样式">
        <div className="flex items-center gap-4">
          <EmojiAvatar emoji={aiAvatarEmoji} color={aiAvatarColor} fallbackChar={aiName} size="lg" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground">{aiName || 'HappyClaw'}</div>
            <div className="text-xs text-muted-foreground mt-0.5">全局默认 · 用户可个人覆盖</div>
          </div>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground mb-1">AI 名称</Label>
          <Input
            type="text"
            value={aiName}
            onChange={(e) => setAiName(e.target.value)}
            maxLength={32}
            placeholder="HappyClaw"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label className="text-[11px] text-muted-foreground mb-1.5">头像 Emoji</Label>
            <EmojiPicker value={aiAvatarEmoji} onChange={setAiAvatarEmoji} />
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground mb-1.5">头像背景色</Label>
            <ColorPicker value={aiAvatarColor} onChange={setAiAvatarColor} />
          </div>
        </div>
      </Section>

      {/* Save */}
      <Button onClick={handleSave} disabled={saving || !aiName.trim()} className="w-full sm:w-auto">
        {saving && <Loader2 className="size-4 animate-spin" />}
        保存全局外观
      </Button>
    </div>
  );
}
