import { useEffect, useRef, useState } from 'react';
import { Loader2, Upload, Trash2, User, Bot, Lock, Palette, Sun, Moon, Monitor, Bell, BellOff, CheckCircle2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

import { useAuthStore } from '../../stores/auth';
import { useTheme, type Theme, type ColorScheme, type FontStyle } from '../../hooks/useTheme';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { EmojiAvatar } from '@/components/common/EmojiAvatar';
import { EmojiPicker } from '@/components/common/EmojiPicker';
import { ColorPicker } from '@/components/common/ColorPicker';
import { isRouteRestoreEnabled, setRouteRestoreEnabled } from '../../utils/routeRestore';
import { getErrorMessage } from './types';
import { SettingsCard as Section } from './SettingsCard';

/* ── Theme / Appearance selectors ─────────────────────────── */

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '系统', icon: Monitor },
];

const SCHEME_OPTIONS: { value: ColorScheme; label: string; preview: { bg: string; accent: string; text: string } }[] = [
  { value: 'default', label: '经典绿', preview: { bg: '#ffffff', accent: '#0d9488', text: '#0f172a' } },
  { value: 'orange', label: '暖橙', preview: { bg: '#FAF9F5', accent: '#f97316', text: '#141413' } },
  { value: 'neutral', label: '素白', preview: { bg: '#ffffff', accent: '#52525b', text: '#18181b' } },
];

const FONT_OPTIONS: { value: FontStyle; label: string; sample: string; fontFamily: string }[] = [
  { value: 'default', label: 'HappyClaw', sample: 'Hello 你好', fontFamily: "'Inter Variable', system-ui, sans-serif" },
  { value: 'anthropic', label: 'Anthropic', sample: 'Hello 你好', fontFamily: "Georgia, 'Noto Serif SC', serif" },
];

function OptionButton({ active, onClick, children, className = '' }: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border-2 transition-all cursor-pointer ${
        active
          ? 'border-primary ring-1 ring-primary/20 bg-primary/5'
          : 'border-border hover:border-muted-foreground/30'
      } ${className}`}
    >
      {children}
    </button>
  );
}

/* ── Desktop Notification Section ─────────────────────────── */

function DesktopNotificationSection() {
  const supported = typeof Notification !== 'undefined';
  const [permission, setPermission] = useState<NotificationPermission>(
    supported ? Notification.permission : 'denied',
  );

  const handleRequest = async () => {
    if (!supported) return;
    const result = await Notification.requestPermission();
    setPermission(result);
  };

  return (
    <Section icon={Bell} title="桌面通知" desc="对话任务完成时通过浏览器弹窗提醒你">
      {!supported ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <BellOff className="size-4 flex-shrink-0" />
          当前浏览器不支持桌面通知
        </div>
      ) : permission === 'granted' ? (
        <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
          <CheckCircle2 className="size-4 flex-shrink-0" />
          桌面通知已开启，对话完成时将弹窗提醒
        </div>
      ) : permission === 'denied' ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
            <BellOff className="size-4 flex-shrink-0" />
            浏览器已拒绝通知权限
          </div>
          <p className="text-xs text-muted-foreground">
            请点击地址栏左侧的锁图标，将「通知」权限改为「允许」，然后刷新页面。
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            开启后，当页面切到后台或切换到其他对话时，任务完成会弹出系统通知。
          </p>
          <Button type="button" size="sm" variant="outline" onClick={handleRequest}>
            <Bell className="size-3.5" />
            开启桌面通知
          </Button>
        </div>
      )}
    </Section>
  );
}

/* ── PWA Route Restore Section ────────────────────────────── */

function PwaRouteRestoreSection() {
  const [enabled, setEnabled] = useState(() => isRouteRestoreEnabled());

  const handleChange = (next: boolean) => {
    setEnabled(next);
    setRouteRestoreEnabled(next);
  };

  return (
    <Section
      icon={RotateCcw}
      title="重启时恢复上次页面"
      desc="安装为 PWA 后，从后台被系统回收再次打开时回到上次访问的页面，而非默认主页"
    >
      <div className="flex items-center justify-between">
        <Label className="text-sm text-foreground">启用恢复</Label>
        <Switch checked={enabled} onCheckedChange={handleChange} aria-label="启用 PWA 重启路由恢复" />
      </div>
    </Section>
  );
}

/* ── Main component ───────────────────────────────────────── */

export function ProfileSection() {
  const { user: currentUser, changePassword, updateProfile, uploadAvatar } = useAuthStore();
  const { theme, setTheme, colorScheme, setColorScheme, fontStyle, setFontStyle } = useTheme();

  // Profile
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [avatarEmoji, setAvatarEmoji] = useState<string | null>(null);
  const [avatarColor, setAvatarColor] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [userAvatarUploading, setUserAvatarUploading] = useState(false);
  const userAvatarInputRef = useRef<HTMLInputElement>(null);

  // AI appearance
  const [aiName, setAiName] = useState('');
  const [aiAvatarEmoji, setAiAvatarEmoji] = useState<string | null>(null);
  const [aiAvatarColor, setAiAvatarColor] = useState<string | null>(null);
  const [aiAvatarUrl, setAiAvatarUrl] = useState<string | null>(null);
  const [aiAppearanceSaving, setAiAppearanceSaving] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Password
  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [pwdChanging, setPwdChanging] = useState(false);

  useEffect(() => {
    setUsername(currentUser?.username || '');
    setDisplayName(currentUser?.display_name || '');
    setAvatarEmoji(currentUser?.avatar_emoji ?? null);
    setAvatarColor(currentUser?.avatar_color ?? null);
    setAvatarUrl(currentUser?.avatar_url ?? null);
    setAiName(currentUser?.ai_name || '');
    setAiAvatarEmoji(currentUser?.ai_avatar_emoji ?? null);
    setAiAvatarColor(currentUser?.ai_avatar_color ?? null);
    setAiAvatarUrl(currentUser?.ai_avatar_url ?? null);
  }, [currentUser?.username, currentUser?.display_name, currentUser?.avatar_emoji, currentUser?.avatar_color, currentUser?.avatar_url, currentUser?.ai_name, currentUser?.ai_avatar_emoji, currentUser?.ai_avatar_color, currentUser?.ai_avatar_url]);

  const handleUpdateProfile = async () => {
    setProfileSaving(true);
    try {
      await updateProfile({
        username: username.trim(),
        display_name: displayName.trim(),
        avatar_emoji: avatarEmoji,
        avatar_color: avatarColor,
      });
      toast.success('基础信息已更新');
    } catch (err) {
      toast.error(getErrorMessage(err, '更新基础信息失败'));
    } finally {
      setProfileSaving(false);
    }
  };

  const handleUserAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    if (file.size > 3 * 1024 * 1024) { toast.error('图片文件不能超过 3MB'); return; }
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type)) {
      toast.error('仅支持 jpg、png、gif、webp 格式'); return;
    }
    setUserAvatarUploading(true);
    try {
      const url = await uploadAvatar(file, 'user');
      setAvatarUrl(url);
      toast.success('头像已上传');
    } catch (err) {
      toast.error(getErrorMessage(err, '上传头像失败'));
    } finally {
      setUserAvatarUploading(false);
    }
  };

  const handleRemoveUserAvatar = async () => {
    try {
      await updateProfile({ avatar_url: null });
      setAvatarUrl(null);
      toast.success('头像已移除');
    } catch (err) {
      toast.error(getErrorMessage(err, '移除头像失败'));
    }
  };

  const handleChangePassword = async () => {
    setPwdChanging(true);
    try {
      await changePassword(currentPwd, newPwd);
      setCurrentPwd('');
      setNewPwd('');
      toast.success('密码已修改');
    } catch (err) {
      toast.error(getErrorMessage(err, '修改密码失败'));
    } finally {
      setPwdChanging(false);
    }
  };

  const handleSaveAiAppearance = async () => {
    setAiAppearanceSaving(true);
    try {
      await updateProfile({
        ai_name: aiName.trim() || null,
        ai_avatar_emoji: aiAvatarEmoji,
        ai_avatar_color: aiAvatarColor,
      });
      toast.success('机器人外观已更新');
    } catch (err) {
      toast.error(getErrorMessage(err, '更新机器人外观失败'));
    } finally {
      setAiAppearanceSaving(false);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    if (file.size > 3 * 1024 * 1024) { toast.error('图片文件不能超过 3MB'); return; }
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type)) {
      toast.error('仅支持 jpg、png、gif、webp 格式'); return;
    }
    setAvatarUploading(true);
    try {
      const url = await uploadAvatar(file);
      setAiAvatarUrl(url);
      toast.success('头像已上传');
    } catch (err) {
      toast.error(getErrorMessage(err, '上传头像失败'));
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleRemoveAvatar = async () => {
    try {
      await updateProfile({ ai_avatar_url: null });
      setAiAvatarUrl(null);
      toast.success('头像已移除');
    } catch (err) {
      toast.error(getErrorMessage(err, '移除头像失败'));
    }
  };

  return (
    <div className="space-y-4">
      {/* ── 1. Theme & Appearance ── */}
      <Section icon={Palette} title="主题与外观" desc="个人界面偏好，仅影响你自己">
        {/* Color scheme */}
        <div>
          <Label className="text-xs text-muted-foreground mb-2">配色方案</Label>
          <div className="grid grid-cols-3 gap-2">
            {SCHEME_OPTIONS.map((opt) => (
              <OptionButton key={opt.value} active={colorScheme === opt.value} onClick={() => setColorScheme(opt.value)} className="flex flex-col gap-2 p-2.5">
                <div
                  className="w-full h-10 rounded-lg border border-black/5 flex items-end p-1.5 gap-1"
                  style={{ background: opt.preview.bg }}
                >
                  <div className="w-4 h-4 rounded-full" style={{ background: opt.preview.accent }} />
                  <div className="flex-1 space-y-0.5">
                    <div className="h-1 rounded-full w-3/4" style={{ background: opt.preview.text, opacity: 0.6 }} />
                    <div className="h-1 rounded-full w-1/2" style={{ background: opt.preview.text, opacity: 0.25 }} />
                  </div>
                </div>
                <span className={`text-xs font-medium ${colorScheme === opt.value ? 'text-primary' : 'text-foreground'}`}>{opt.label}</span>
              </OptionButton>
            ))}
          </div>
        </div>

        {/* Light / Dark / System */}
        <div>
          <Label className="text-xs text-muted-foreground mb-2">明暗模式</Label>
          <div className="grid grid-cols-3 gap-2">
            {THEME_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              return (
                <OptionButton key={opt.value} active={theme === opt.value} onClick={() => setTheme(opt.value)} className="flex flex-col items-center gap-1 py-2.5 px-2">
                  <Icon className={`w-4 h-4 ${theme === opt.value ? 'text-primary' : 'text-muted-foreground'}`} />
                  <span className={`text-xs font-medium ${theme === opt.value ? 'text-primary' : 'text-foreground'}`}>{opt.label}</span>
                </OptionButton>
              );
            })}
          </div>
        </div>

        {/* Font style */}
        <div>
          <Label className="text-xs text-muted-foreground mb-2">字体风格</Label>
          <div className="grid grid-cols-2 gap-2">
            {FONT_OPTIONS.map((opt) => (
              <OptionButton key={opt.value} active={fontStyle === opt.value} onClick={() => setFontStyle(opt.value)} className="flex flex-col gap-1.5 p-2.5">
                <span className="text-sm leading-snug text-foreground truncate" style={{ fontFamily: opt.fontFamily }}>{opt.sample}</span>
                <span className={`text-xs font-medium ${fontStyle === opt.value ? 'text-primary' : 'text-foreground'}`}>{opt.label}</span>
              </OptionButton>
            ))}
          </div>
        </div>
      </Section>

      {/* ── 2. Desktop Notifications ── */}
      <DesktopNotificationSection />

      {/* ── 2.5 PWA Route Restore ── */}
      <PwaRouteRestoreSection />

      {/* ── 3. Account Info ── */}
      <Section icon={User} title="账户信息">
        <div className="flex items-center gap-4">
          <EmojiAvatar imageUrl={avatarUrl} emoji={avatarEmoji} color={avatarColor} fallbackChar={displayName || username} size="lg" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground">{displayName || username || '未设置'}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {currentUser?.role === 'admin' ? '管理员' : '普通成员'} · {currentUser?.status === 'active' ? '已启用' : '已禁用'}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground mb-1">用户名</Label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1">显示名称</Label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
        </div>

        <div className="space-y-3">
          <Label className="text-xs text-muted-foreground">头像</Label>
          <div>
            <Label className="text-[11px] text-muted-foreground mb-1.5">上传图片</Label>
            <input ref={userAvatarInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden" onChange={handleUserAvatarUpload} />
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" disabled={userAvatarUploading} onClick={() => userAvatarInputRef.current?.click()}>
                {userAvatarUploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                上传头像
              </Button>
              {avatarUrl && (
                <Button type="button" variant="ghost" size="sm" onClick={handleRemoveUserAvatar}>
                  <Trash2 className="size-3.5" /> 移除
                </Button>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">jpg/png/gif/webp，最大 3MB。上传后优先于 Emoji 显示</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-[11px] text-muted-foreground mb-1.5">Emoji</Label>
              <EmojiPicker value={avatarEmoji ?? undefined} onChange={setAvatarEmoji} />
            </div>
            <div>
              <Label className="text-[11px] text-muted-foreground mb-1.5">背景色</Label>
              <ColorPicker value={avatarColor ?? undefined} onChange={setAvatarColor} />
            </div>
          </div>
        </div>

        <Button onClick={handleUpdateProfile} disabled={profileSaving || !username.trim()} size="sm">
          {profileSaving && <Loader2 className="size-4 animate-spin" />}
          保存
        </Button>
      </Section>

      {/* ── 3. AI Bot Appearance ── */}
      <Section icon={Bot} title="我的机器人" desc="自定义 AI 助手外观，仅影响你看到的对话界面">
        <div className="flex items-center gap-4">
          <EmojiAvatar imageUrl={aiAvatarUrl} emoji={aiAvatarEmoji} color={aiAvatarColor} fallbackChar={aiName || 'AI'} size="lg" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground">{aiName || '使用系统默认'}</div>
            <div className="text-xs text-muted-foreground mt-0.5">个人 AI 外观覆盖</div>
          </div>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground mb-1">AI 名称</Label>
          <Input value={aiName} onChange={(e) => setAiName(e.target.value)} placeholder="留空使用系统默认" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label className="text-[11px] text-muted-foreground mb-1.5">Emoji</Label>
            <EmojiPicker value={aiAvatarEmoji ?? undefined} onChange={setAiAvatarEmoji} />
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground mb-1.5">背景色</Label>
            <ColorPicker value={aiAvatarColor ?? undefined} onChange={setAiAvatarColor} />
          </div>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground mb-1">自定义头像图片</Label>
          <input ref={avatarInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden" onChange={handleAvatarUpload} />
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={avatarUploading} onClick={() => avatarInputRef.current?.click()}>
              {avatarUploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
              上传图片
            </Button>
            {aiAvatarUrl && (
              <Button type="button" variant="ghost" size="sm" onClick={handleRemoveAvatar}>
                <Trash2 className="size-3.5" /> 移除
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">jpg/png/gif/webp，最大 3MB</p>
        </div>

        <Button onClick={handleSaveAiAppearance} disabled={aiAppearanceSaving} size="sm">
          {aiAppearanceSaving && <Loader2 className="size-4 animate-spin" />}
          保存
        </Button>
      </Section>

      {/* ── 4. Password ── */}
      <Section icon={Lock} title="修改密码">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground mb-1">当前密码</Label>
            <Input type="password" value={currentPwd} onChange={(e) => setCurrentPwd(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1">新密码</Label>
            <Input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} placeholder="至少 8 位" />
          </div>
        </div>
        <Button onClick={handleChangePassword} disabled={pwdChanging || !currentPwd || !newPwd} size="sm">
          {pwdChanging && <Loader2 className="size-4 animate-spin" />}
          修改密码
        </Button>
      </Section>
    </div>
  );
}
