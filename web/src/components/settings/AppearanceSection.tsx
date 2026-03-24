import { useEffect, useState } from 'react';
import { Loader2, Sun, Moon, Monitor } from 'lucide-react';
import { toast } from 'sonner';

import { useAuthStore } from '../../stores/auth';
import { useTheme, type Theme, type ColorScheme, type FontStyle } from '../../hooks/useTheme';
import { api } from '../../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { EmojiAvatar } from '@/components/common/EmojiAvatar';
import { EmojiPicker } from '@/components/common/EmojiPicker';
import { ColorPicker } from '@/components/common/ColorPicker';
import { getErrorMessage } from './types';
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
    return (
      <div className="space-y-6">
        <ThemeSelector />
        <p className="text-sm text-muted-foreground">需要系统配置权限才能修改其他外观设置。</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ThemeSelector />

      <p className="text-sm text-muted-foreground bg-muted rounded-lg px-4 py-3">
        以下为全局默认值，对所有用户生效。用户可在「个人资料」中覆盖自己的 AI 外观。
      </p>
      {/* Preview */}
      <div>
        <h3 className="text-base font-semibold text-foreground mb-4">预览</h3>
        <div className="flex items-center gap-3 p-4 bg-muted rounded-lg">
          <EmojiAvatar
            emoji={aiAvatarEmoji}
            color={aiAvatarColor}
            fallbackChar={aiName}
            size="lg"
          />
          <div>
            <div className="text-sm font-medium text-foreground">{aiName || 'HappyClaw'}</div>
            <div className="text-xs text-muted-foreground">AI 助手</div>
          </div>
        </div>
      </div>

      {/* App Name */}
      <div>
        <h3 className="text-base font-semibold text-foreground mb-4">项目名称</h3>
        <Input
          type="text"
          value={appName}
          onChange={(e) => setAppName(e.target.value)}
          maxLength={32}
          placeholder="HappyClaw"
          className="max-w-xs"
        />
        <p className="text-xs text-muted-foreground mt-1">显示在 Logo 旁边和欢迎页的项目名称</p>
      </div>

      {/* AI Name */}
      <div>
        <h3 className="text-base font-semibold text-foreground mb-4">AI 默认名称</h3>
        <Input
          type="text"
          value={aiName}
          onChange={(e) => setAiName(e.target.value)}
          maxLength={32}
          placeholder="HappyClaw"
          className="max-w-xs"
        />
        <p className="text-xs text-muted-foreground mt-1">所有用户看到的默认 AI 助手名称（用户可在个人资料中单独覆盖）</p>
      </div>

      {/* AI Avatar Emoji */}
      <div>
        <h3 className="text-base font-semibold text-foreground mb-4">AI 头像 Emoji</h3>
        <EmojiPicker value={aiAvatarEmoji} onChange={setAiAvatarEmoji} />
      </div>

      {/* AI Avatar Color */}
      <div>
        <h3 className="text-base font-semibold text-foreground mb-4">AI 头像背景色</h3>
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

/* ── Theme selector sub-components ─────────────────────────── */

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
];

const SCHEME_OPTIONS: { value: ColorScheme; label: string; preview: { bg: string; accent: string; text: string } }[] = [
  { value: 'default', label: '暖橙', preview: { bg: '#FAF9F5', accent: '#f97316', text: '#141413' } },
  { value: 'neutral', label: '素白', preview: { bg: '#ffffff', accent: '#52525b', text: '#18181b' } },
];

const FONT_OPTIONS: { value: FontStyle; label: string; sample: string; fontFamily: string }[] = [
  { value: 'default', label: 'HappyClaw', sample: 'Hello 你好', fontFamily: "'Inter Variable', system-ui, sans-serif" },
  { value: 'anthropic', label: 'Anthropic', sample: 'Hello 你好', fontFamily: "Georgia, 'Noto Serif SC', serif" },
];

function ThemeSelector() {
  const { theme, setTheme, colorScheme, setColorScheme, fontStyle, setFontStyle } = useTheme();

  return (
    <div className="space-y-6">
      {/* Color scheme */}
      <div>
        <h3 className="text-base font-semibold text-foreground mb-1">主题色</h3>
        <p className="text-xs text-muted-foreground mb-3">选择界面的配色方案</p>
        <div className="grid grid-cols-2 gap-3">
          {SCHEME_OPTIONS.map((opt) => {
            const active = colorScheme === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setColorScheme(opt.value)}
                className={`relative flex flex-col gap-2.5 p-3 rounded-xl border-2 transition-all cursor-pointer ${
                  active
                    ? 'border-primary ring-1 ring-primary/20'
                    : 'border-border hover:border-muted-foreground/30'
                }`}
              >
                <div
                  className="w-full h-14 rounded-lg border border-black/5 overflow-hidden flex items-end p-2 gap-1.5"
                  style={{ background: opt.preview.bg }}
                >
                  <div className="w-5 h-5 rounded-full" style={{ background: opt.preview.accent }} />
                  <div className="flex-1 space-y-1">
                    <div className="h-1.5 rounded-full w-3/4" style={{ background: opt.preview.text, opacity: 0.7 }} />
                    <div className="h-1.5 rounded-full w-1/2" style={{ background: opt.preview.text, opacity: 0.3 }} />
                  </div>
                </div>
                <span className={`text-sm font-medium ${active ? 'text-primary' : 'text-foreground'}`}>
                  {opt.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Font style */}
      <div>
        <h3 className="text-base font-semibold text-foreground mb-1">字体风格</h3>
        <p className="text-xs text-muted-foreground mb-3">AI 回复和界面的字体</p>
        <div className="grid grid-cols-2 gap-3">
          {FONT_OPTIONS.map((opt) => {
            const active = fontStyle === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setFontStyle(opt.value)}
                className={`flex flex-col gap-2 p-3 rounded-xl border-2 transition-all cursor-pointer ${
                  active
                    ? 'border-primary ring-1 ring-primary/20'
                    : 'border-border hover:border-muted-foreground/30'
                }`}
              >
                <span
                  className="text-base leading-snug text-foreground truncate"
                  style={{ fontFamily: opt.fontFamily }}
                >
                  {opt.sample}
                </span>
                <span className={`text-sm font-medium ${active ? 'text-primary' : 'text-foreground'}`}>
                  {opt.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Light / Dark / System */}
      <div>
        <h3 className="text-base font-semibold text-foreground mb-1">明暗模式</h3>
        <p className="text-xs text-muted-foreground mb-3">选择亮色或暗色外观</p>
        <div className="grid grid-cols-3 gap-3">
          {THEME_OPTIONS.map((opt) => {
            const active = theme === opt.value;
            const Icon = opt.icon;
            return (
              <button
                key={opt.value}
                onClick={() => setTheme(opt.value)}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border-2 transition-all cursor-pointer ${
                  active
                    ? 'border-primary bg-accent'
                    : 'border-border hover:border-muted-foreground/30'
                }`}
              >
                <Icon className={`w-5 h-5 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
                <span className={`text-sm font-medium ${active ? 'text-primary' : 'text-foreground'}`}>
                  {opt.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
