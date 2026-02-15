import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { useAuthStore } from '../../stores/auth';
import { api } from '../../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { EmojiAvatar } from '@/components/common/EmojiAvatar';
import { EmojiPicker } from '@/components/common/EmojiPicker';
import { ColorPicker } from '@/components/common/ColorPicker';
import type { SettingsNotification } from './types';
import { getErrorMessage } from './types';
import type { AppearanceConfig } from '../../stores/auth';

interface AppearanceSectionProps extends SettingsNotification {}

export function AppearanceSection({ setNotice, setError }: AppearanceSectionProps) {
  const { hasPermission } = useAuthStore();

  const [aiName, setAiName] = useState('');
  const [aiAvatarEmoji, setAiAvatarEmoji] = useState('');
  const [aiAvatarColor, setAiAvatarColor] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const canManage = hasPermission('manage_system_config');

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const data = await api.get<AppearanceConfig>('/api/config/appearance');
        setAiName(data.aiName);
        setAiAvatarEmoji(data.aiAvatarEmoji);
        setAiAvatarColor(data.aiAvatarColor);
      } catch (err) {
        setError(getErrorMessage(err, '加载外观配置失败'));
      } finally {
        setLoading(false);
      }
    })();
  }, [setError]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api.put<AppearanceConfig>('/api/config/appearance', {
        aiName: aiName.trim(),
        aiAvatarEmoji,
        aiAvatarColor,
      });
      setAiName(data.aiName);
      setAiAvatarEmoji(data.aiAvatarEmoji);
      setAiAvatarColor(data.aiAvatarColor);
      useAuthStore.setState({ appearance: data });
      setNotice('外观设置已保存');
    } catch (err) {
      setError(getErrorMessage(err, '保存外观设置失败'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!canManage) {
    return <div className="text-sm text-slate-500">需要系统配置权限才能修改外观设置。</div>;
  }

  return (
    <div className="space-y-6">
      {/* Preview */}
      <div>
        <h3 className="text-base font-semibold text-slate-900 mb-4">预览</h3>
        <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-lg">
          <EmojiAvatar
            emoji={aiAvatarEmoji}
            color={aiAvatarColor}
            fallbackChar={aiName}
            size="lg"
          />
          <div>
            <div className="text-sm font-medium text-slate-900">{aiName || 'HappyClaw'}</div>
            <div className="text-xs text-slate-500">AI 助手</div>
          </div>
        </div>
      </div>

      {/* AI Name */}
      <div>
        <h3 className="text-base font-semibold text-slate-900 mb-4">AI 名称</h3>
        <Input
          type="text"
          value={aiName}
          onChange={(e) => setAiName(e.target.value)}
          maxLength={32}
          placeholder="HappyClaw"
          className="max-w-xs"
        />
        <p className="text-xs text-slate-500 mt-1">显示在聊天界面和消息中的 AI 名称，最多 32 个字符</p>
      </div>

      {/* AI Avatar Emoji */}
      <div>
        <h3 className="text-base font-semibold text-slate-900 mb-4">AI 头像 Emoji</h3>
        <EmojiPicker value={aiAvatarEmoji} onChange={setAiAvatarEmoji} />
      </div>

      {/* AI Avatar Color */}
      <div>
        <h3 className="text-base font-semibold text-slate-900 mb-4">AI 头像背景色</h3>
        <ColorPicker value={aiAvatarColor} onChange={setAiAvatarColor} />
      </div>

      {/* Save */}
      <div>
        <Button onClick={handleSave} disabled={saving || !aiName.trim()}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          保存外观设置
        </Button>
      </div>
    </div>
  );
}
