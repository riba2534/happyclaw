import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useAuthStore } from '../stores/auth';
import { SettingsNav } from '../components/settings/SettingsNav';
import { ChannelsSection } from '../components/settings/ChannelsSection';
import { ClaudeProviderSection } from '../components/settings/ClaudeProviderSection';
import { RegistrationSection } from '../components/settings/RegistrationSection';
import { ProfileSection } from '../components/settings/ProfileSection';
import { SecuritySection } from '../components/settings/SecuritySection';
import { AboutSection } from '../components/settings/AboutSection';
import { AppearanceSection } from '../components/settings/AppearanceSection';
import { GroupsPage } from './GroupsPage';
import { MemoryPage } from './MemoryPage';
import { SkillsPage } from './SkillsPage';
import { UsersPage } from './UsersPage';
import type { SettingsTab } from '../components/settings/types';

const VALID_TABS: SettingsTab[] = ['channels', 'claude', 'registration', 'appearance', 'profile', 'security', 'groups', 'memory', 'skills', 'users', 'about'];
const SYSTEM_TABS: SettingsTab[] = ['channels', 'claude', 'registration', 'appearance'];
const FULLPAGE_TABS: SettingsTab[] = ['groups', 'memory', 'skills', 'users'];

export function SettingsPage() {
  const { user: currentUser } = useAuthStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasSystemConfigPermission =
    currentUser?.role === 'admin' || !!currentUser?.permissions.includes('manage_system_config');
  const mustChangePassword = !!currentUser?.must_change_password;
  const canManageSystemConfig = hasSystemConfigPermission && !mustChangePassword;
  const canManageUsers =
    currentUser?.role === 'admin' ||
    !!currentUser?.permissions.includes('manage_users') ||
    !!currentUser?.permissions.includes('manage_invites') ||
    !!currentUser?.permissions.includes('view_audit_log');

  const defaultTab: SettingsTab = canManageSystemConfig ? 'channels' : 'profile';

  const activeTab = useMemo((): SettingsTab => {
    if (mustChangePassword) return 'profile';
    const raw = searchParams.get('tab') as SettingsTab | null;
    if (raw && VALID_TABS.includes(raw)) {
      if (SYSTEM_TABS.includes(raw) && !canManageSystemConfig) return defaultTab;
      return raw;
    }
    return defaultTab;
  }, [searchParams, canManageSystemConfig, mustChangePassword, defaultTab]);

  const handleTabChange = useCallback((tab: SettingsTab) => {
    setNotice(null);
    setError(null);
    setSearchParams({ tab }, { replace: true });
  }, [setSearchParams]);

  const sectionTitle: Record<SettingsTab, string> = {
    channels: '渠道配置',
    claude: 'Claude 提供商',
    registration: '注册管理',
    appearance: '外观设置',
    profile: '个人资料',
    security: '安全与设备',
    groups: '会话管理',
    memory: '记忆管理',
    skills: '技能管理',
    users: '用户管理',
    about: '关于',
  };

  return (
    <div className="min-h-full bg-slate-50 flex flex-col lg:flex-row">
      <SettingsNav
        activeTab={activeTab}
        onTabChange={handleTabChange}
        canManageSystemConfig={canManageSystemConfig}
        canManageUsers={!!canManageUsers}
        mustChangePassword={mustChangePassword}
      />

      <div className="flex-1 overflow-y-auto">
        {FULLPAGE_TABS.includes(activeTab) ? (
          <>
            {activeTab === 'groups' && <GroupsPage />}
            {activeTab === 'memory' && <MemoryPage />}
            {activeTab === 'skills' && <SkillsPage />}
            {activeTab === 'users' && <UsersPage />}
          </>
        ) : (
          <div className="p-4 lg:p-8">
            <div className="max-w-3xl mx-auto space-y-6">
              <div>
                <h1 className="text-2xl font-bold text-slate-900">{sectionTitle[activeTab]}</h1>
              </div>

              {mustChangePassword && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
                  检测到首次登录或管理员重置密码，请先完成"修改密码"，其余关键操作会被暂时限制。
                </div>
              )}

              {(notice || error) && (
                <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-1">
                  {notice && <div className="text-sm text-green-600">{notice}</div>}
                  {error && <div className="text-sm text-red-600">{error}</div>}
                </div>
              )}

              <div className="bg-white rounded-xl border border-slate-200 p-6">
                {activeTab === 'channels' && <ChannelsSection setNotice={setNotice} setError={setError} />}
                {activeTab === 'claude' && <ClaudeProviderSection setNotice={setNotice} setError={setError} />}
                {activeTab === 'registration' && <RegistrationSection setNotice={setNotice} setError={setError} />}
                {activeTab === 'appearance' && <AppearanceSection setNotice={setNotice} setError={setError} />}
                {activeTab === 'profile' && <ProfileSection setNotice={setNotice} setError={setError} />}
                {activeTab === 'security' && <SecuritySection setNotice={setNotice} setError={setError} />}
                {activeTab === 'about' && <AboutSection />}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
