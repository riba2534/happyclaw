import { useEffect, useRef, useState } from 'react';
import { Loader2, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ColorPicker } from '@/components/common/ColorPicker';
import { EmojiAvatar } from '@/components/common/EmojiAvatar';
import { EmojiPicker } from '@/components/common/EmojiPicker';
import { useAuthStore } from '../../stores/auth';
import {
  SettingsField,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from './SettingsLayout';
import { SettingsFormFooter } from './SettingsFormControls';
import { getErrorMessage } from './types';

export function ProfileSection() {
  const { user: currentUser, updateProfile, uploadAvatar } = useAuthStore();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [avatarEmoji, setAvatarEmoji] = useState<string | null>(null);
  const [avatarColor, setAvatarColor] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setUsername(currentUser?.username || '');
    setDisplayName(currentUser?.display_name || '');
    setAvatarEmoji(currentUser?.avatar_emoji ?? null);
    setAvatarColor(currentUser?.avatar_color ?? null);
    setAvatarUrl(currentUser?.avatar_url ?? null);
  }, [
    currentUser?.username,
    currentUser?.display_name,
    currentUser?.avatar_emoji,
    currentUser?.avatar_color,
    currentUser?.avatar_url,
  ]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateProfile({
        username: username.trim(),
        display_name: displayName.trim(),
        avatar_emoji: avatarEmoji,
        avatar_color: avatarColor,
      });
      toast.success('个人资料已更新');
    } catch (error) {
      toast.error(getErrorMessage(error, '更新个人资料失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';

    if (file.size > 3 * 1024 * 1024) {
      toast.error('图片文件不能超过 3MB');
      return;
    }
    if (
      !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(
        file.type,
      )
    ) {
      toast.error('仅支持 jpg、png、gif、webp 格式');
      return;
    }

    setUploading(true);
    try {
      setAvatarUrl(await uploadAvatar(file, 'user'));
      toast.success('头像已上传');
    } catch (error) {
      toast.error(getErrorMessage(error, '上传头像失败'));
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveAvatar = async () => {
    try {
      await updateProfile({ avatar_url: null });
      setAvatarUrl(null);
      toast.success('头像已移除');
    } catch (error) {
      toast.error(getErrorMessage(error, '移除头像失败'));
    }
  };

  return (
    <div className="space-y-8">
      <SettingsGroup>
        <div className="flex items-center gap-3 px-4 py-4">
          <EmojiAvatar
            imageUrl={avatarUrl}
            emoji={avatarEmoji}
            color={avatarColor}
            fallbackChar={displayName || username}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-body font-medium text-foreground">
              {displayName || username || '未设置'}
            </div>
            <div className="mt-0.5 text-caption text-muted-foreground">
              {currentUser?.role === 'admin' ? '管理员' : '普通成员'} ·{' '}
              {currentUser?.status === 'active' ? '已启用' : '已禁用'}
            </div>
          </div>
        </div>
        <SettingsRow
          label="登录用户名"
          htmlFor="profile-username"
          control={
            <Input
              id="profile-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              className="sm:w-64"
            />
          }
        />
        <SettingsRow
          label="显示名称"
          htmlFor="profile-display-name"
          control={
            <Input
              id="profile-display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="sm:w-64"
            />
          }
        />
      </SettingsGroup>

      <SettingsSection
        title="头像"
        description="jpg、png、gif 或 webp，最大 3MB；图片优先于 Emoji 显示。"
        actions={
          <>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              className="hidden"
              onChange={handleAvatarUpload}
            />
            {avatarUrl && (
              <Button
                type="button"
                variant="ghost"
                onClick={handleRemoveAvatar}
              >
                <Trash2 className="size-4" />
                移除图片
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={uploading}
              onClick={() => avatarInputRef.current?.click()}
            >
              {uploading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              上传图片
            </Button>
          </>
        }
      >
        <SettingsGroup>
          <div className="grid gap-6 px-4 py-4 sm:grid-cols-2">
            <SettingsField label="Emoji">
              <EmojiPicker
                value={avatarEmoji ?? undefined}
                onChange={setAvatarEmoji}
              />
            </SettingsField>
            <SettingsField label="背景色">
              <ColorPicker
                value={avatarColor ?? undefined}
                onChange={setAvatarColor}
              />
            </SettingsField>
          </div>
        </SettingsGroup>
        <SettingsFormFooter>
          <Button onClick={handleSave} disabled={saving || !username.trim()}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            保存个人资料
          </Button>
        </SettingsFormFooter>
      </SettingsSection>
    </div>
  );
}
