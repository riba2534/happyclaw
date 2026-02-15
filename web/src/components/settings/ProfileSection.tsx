import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { useAuthStore } from '../../stores/auth';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { EmojiAvatar } from '@/components/common/EmojiAvatar';
import { EmojiPicker } from '@/components/common/EmojiPicker';
import { ColorPicker } from '@/components/common/ColorPicker';
import type { SettingsNotification } from './types';
import { getErrorMessage } from './types';

interface ProfileSectionProps extends SettingsNotification {}

export function ProfileSection({ setNotice, setError }: ProfileSectionProps) {
  const { user: currentUser, changePassword, updateProfile } = useAuthStore();

  // Profile
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [avatarEmoji, setAvatarEmoji] = useState<string | null>(null);
  const [avatarColor, setAvatarColor] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);

  // Password
  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [pwdChanging, setPwdChanging] = useState(false);

  useEffect(() => {
    setUsername(currentUser?.username || '');
    setDisplayName(currentUser?.display_name || '');
    setAvatarEmoji(currentUser?.avatar_emoji ?? null);
    setAvatarColor(currentUser?.avatar_color ?? null);
  }, [currentUser?.username, currentUser?.display_name, currentUser?.avatar_emoji, currentUser?.avatar_color]);

  const handleUpdateProfile = async () => {
    setProfileSaving(true);
    setError(null);
    setNotice(null);
    try {
      await updateProfile({
        username: username.trim(),
        display_name: displayName.trim(),
        avatar_emoji: avatarEmoji,
        avatar_color: avatarColor,
      });
      setNotice('基础信息已更新');
    } catch (err) {
      setError(getErrorMessage(err, '更新基础信息失败'));
    } finally {
      setProfileSaving(false);
    }
  };

  const handleChangePassword = async () => {
    setPwdChanging(true);
    setError(null);
    setNotice(null);
    try {
      await changePassword(currentPwd, newPwd);
      setCurrentPwd('');
      setNewPwd('');
      setNotice('密码已修改');
    } catch (err) {
      setError(getErrorMessage(err, '修改密码失败'));
    } finally {
      setPwdChanging(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Avatar */}
      <div>
        <h3 className="text-base font-semibold text-slate-900 mb-4">头像设置</h3>
        <div className="flex items-center gap-4 mb-4">
          <EmojiAvatar
            emoji={avatarEmoji}
            color={avatarColor}
            fallbackChar={displayName || username}
            size="lg"
          />
          <div className="text-sm text-slate-500">
            选择一个 Emoji 和背景色作为你的头像
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-slate-500 mb-2">Emoji</label>
            <EmojiPicker value={avatarEmoji ?? undefined} onChange={setAvatarEmoji} />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-2">背景色</label>
            <ColorPicker value={avatarColor ?? undefined} onChange={setAvatarColor} />
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-slate-200" />

      {/* Account Info */}
      <div>
        <h3 className="text-base font-semibold text-slate-900 mb-4">账户信息</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <label className="block text-xs text-slate-500 mb-1">用户名</label>
            <Input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">显示名称</label>
            <Input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-slate-500">
          <span>角色：{currentUser?.role === 'admin' ? '管理员' : '普通成员'}</span>
          <span>状态：{currentUser?.status === 'active' ? '启用' : currentUser?.status === 'disabled' ? '禁用' : '已删除'}</span>
          <span>最近登录：{currentUser?.last_login_at ? new Date(currentUser.last_login_at).toLocaleString('zh-CN') : '-'}</span>
        </div>
        {currentUser?.permissions && currentUser.permissions.length > 0 && (
          <div className="mt-3 text-xs text-slate-500">
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
      <div className="border-t border-slate-200" />

      {/* Change Password */}
      <div>
        <h3 className="text-base font-semibold text-slate-900 mb-4">修改密码</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-slate-600 mb-1">当前密码</label>
            <Input
              type="password"
              value={currentPwd}
              onChange={(e) => setCurrentPwd(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">新密码</label>
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
