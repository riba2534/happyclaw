import { useEffect, useRef, useState } from 'react';
import { Loader2, Upload, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { useAuthStore } from '../../stores/auth';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { EmojiAvatar } from '@/components/common/EmojiAvatar';
import { EmojiPicker } from '@/components/common/EmojiPicker';
import { ColorPicker } from '@/components/common/ColorPicker';
import { getErrorMessage } from './types';

export function ProfileSection() {
  const { user: currentUser, changePassword, updateProfile, uploadAvatar } = useAuthStore();

  // Profile
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [avatarEmoji, setAvatarEmoji] = useState<string | null>(null);
  const [avatarColor, setAvatarColor] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);

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
    setAiName(currentUser?.ai_name || '');
    setAiAvatarEmoji(currentUser?.ai_avatar_emoji ?? null);
    setAiAvatarColor(currentUser?.ai_avatar_color ?? null);
    setAiAvatarUrl(currentUser?.ai_avatar_url ?? null);
  }, [currentUser?.username, currentUser?.display_name, currentUser?.avatar_emoji, currentUser?.avatar_color, currentUser?.ai_name, currentUser?.ai_avatar_emoji, currentUser?.ai_avatar_color, currentUser?.ai_avatar_url]);

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
    // Reset input so re-selecting same file triggers onChange
    e.target.value = '';

    if (file.size > 2 * 1024 * 1024) {
      toast.error('图片文件不能超过 2MB');
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type)) {
      toast.error('仅支持 jpg、png、gif、webp 格式');
      return;
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
    <div className="space-y-6">
      {/* Avatar */}
      <div>
        <h3 className="text-base font-semibold text-foreground mb-4">头像设置</h3>
        <div className="flex items-center gap-4 mb-4">
          <EmojiAvatar
            emoji={avatarEmoji}
            color={avatarColor}
            fallbackChar={displayName || username}
            size="lg"
          />
          <div className="text-sm text-muted-foreground">
            选择一个 Emoji 和背景色作为你的头像
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <Label className="text-xs text-muted-foreground mb-2">Emoji</Label>
            <EmojiPicker value={avatarEmoji ?? undefined} onChange={setAvatarEmoji} />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-2">背景色</Label>
            <ColorPicker value={avatarColor ?? undefined} onChange={setAvatarColor} />
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-border" />

      {/* Account Info */}
      <div>
        <h3 className="text-base font-semibold text-foreground mb-4">账户信息</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <Label className="text-xs text-muted-foreground mb-1">用户名</Label>
            <Input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1">显示名称</Label>
            <Input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <span>角色：{currentUser?.role === 'admin' ? '管理员' : '普通成员'}</span>
          <span>状态：{currentUser?.status === 'active' ? '启用' : currentUser?.status === 'disabled' ? '禁用' : '已删除'}</span>
          <span>最近登录：{currentUser?.last_login_at ? new Date(currentUser.last_login_at).toLocaleString('zh-CN') : '-'}</span>
        </div>
        {currentUser?.permissions && currentUser.permissions.length > 0 && (
          <div className="mt-3 text-xs text-muted-foreground">
            权限：{currentUser.permissions.join(', ')}
          </div>
        )}
        <div className="mt-4">
          <Button
            onClick={handleUpdateProfile}
            disabled={profileSaving || !username.trim()}
          >
            {profileSaving && <Loader2 className="size-4 animate-spin" />}
            保存基础信息
          </Button>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-border" />

      {/* AI Appearance */}
      <div>
        <h3 className="text-base font-semibold text-foreground mb-4">我的机器人外观</h3>
        <p className="text-xs text-muted-foreground mb-4">
          自定义你的 AI 助手外观，覆盖系统默认值，仅影响你看到的对话界面。
        </p>
        <div className="space-y-4">
          <div className="flex items-center gap-4 mb-4">
            <EmojiAvatar
              imageUrl={aiAvatarUrl}
              emoji={aiAvatarEmoji}
              color={aiAvatarColor}
              fallbackChar={aiName || 'AI'}
              size="lg"
            />
            <div className="text-sm text-muted-foreground">
              设置机器人的头像图片、Emoji 和背景色
            </div>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1">AI 名称</Label>
            <Input
              type="text"
              value={aiName}
              onChange={(e) => setAiName(e.target.value)}
              placeholder="留空使用系统默认"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-2">Emoji</Label>
            <EmojiPicker value={aiAvatarEmoji ?? undefined} onChange={setAiAvatarEmoji} />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-2">背景色</Label>
            <ColorPicker value={aiAvatarColor ?? undefined} onChange={setAiAvatarColor} />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1">自定义头像图片</Label>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              className="hidden"
              onChange={handleAvatarUpload}
            />
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={avatarUploading}
                onClick={() => avatarInputRef.current?.click()}
              >
                {avatarUploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                上传图片
              </Button>
              {aiAvatarUrl && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleRemoveAvatar}
                >
                  <Trash2 className="size-4" />
                  移除
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              支持 jpg、png、gif、webp，最大 2MB。上传后将优先于 Emoji 头像显示
            </p>
          </div>
        </div>
        <div className="mt-4">
          <Button onClick={handleSaveAiAppearance} disabled={aiAppearanceSaving}>
            {aiAppearanceSaving && <Loader2 className="size-4 animate-spin" />}
            保存机器人外观
          </Button>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-border" />

      {/* Change Password */}
      <div>
        <h3 className="text-base font-semibold text-foreground mb-4">修改密码</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label className="text-xs text-muted-foreground mb-1">当前密码</Label>
            <Input
              type="password"
              value={currentPwd}
              onChange={(e) => setCurrentPwd(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1">新密码</Label>
            <Input
              type="password"
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              placeholder="至少 8 位"
            />
          </div>
        </div>
        <div className="mt-4">
          <Button onClick={handleChangePassword} disabled={pwdChanging || !currentPwd || !newPwd}>
            {pwdChanging && <Loader2 className="size-4 animate-spin" />}
            修改密码
          </Button>
        </div>
      </div>
    </div>
  );
}
