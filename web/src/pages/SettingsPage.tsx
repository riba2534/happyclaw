import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Menu } from 'lucide-react';

import { useAuthStore } from '../stores/auth';
import { SettingsNav } from '../components/settings/SettingsNav';
import { ChannelsSection } from '../components/settings/ChannelsSection';
import { ClaudeProviderSection } from '../components/settings/ClaudeProviderSection';
import { RegistrationSection } from '../components/settings/RegistrationSection';
import { ProfileSection } from '../components/settings/ProfileSection';
import { SecuritySection } from '../components/settings/SecuritySection';
import { AboutSection } from '../components/settings/AboutSection';
import { AppearanceSection } from '../components/settings/AppearanceSection';
import { UserChannelsSection } from '../components/settings/UserChannelsSection';
import { GroupsPage } from './GroupsPage';
import { MemoryPage } from './MemoryPage';
import { SkillsPage } from './SkillsPage';
import { UsersPage } from './UsersPage';
import type { SettingsTab } from '../components/settings/types';

const VALID_TABS: SettingsTab[] = ['channels', 'claude', 'registration', 'appearance', 'profile', 'my-channels', 'security', 'groups', 'memory', 'skills', 'users', 'about'];
const SYSTEM_TABS: SettingsTab[] = ['channels', 'claude', 'registration', 'appearance'];
const FULLPAGE_TABS: SettingsTab[] = ['groups', 'memory', 'skills', 'users'];

export function SettingsPage() {
  const { user: currentUser } = useAuthStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);

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
    setNavOpen(false);
    setSearchParams({ tab }, { replace: true });
  }, [setSearchParams]);

  // Mobile horizontal tab bar
  const mobileTabs = useMemo(() => {
    const tabs: { key: SettingsTab; label: string }[] = [];
    tabs.push({ key: 'profile', label: '个人资料' });
    tabs.push({ key: 'my-channels', label: '消息通道' });
    tabs.push({ key: 'security', label: '安全' });
    if (canManageSystemConfig) {
      tabs.push({ key: 'channels', label: '渠道' });
      tabs.push({ key: 'claude', label: 'Claude' });
      tabs.push({ key: 'appearance', label: '外观' });
    }
    tabs.push({ key: 'groups', label: '会话' });
    tabs.push({ key: 'memory', label: '记忆' });
    tabs.push({ key: 'skills', label: '技能' });
    if (canManageUsers) {
      tabs.push({ key: 'users', label: '用户' });
    }
    return tabs;
  }, [canManageSystemConfig, canManageUsers]);

  const tabBarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = tabBarRef.current;
    if (!container) return;
    const activeEl = container.querySelector('[data-active="true"]');
    if (activeEl) {
      activeEl.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    }
  }, [activeTab]);

  const sectionTitle: Record<SettingsTab, string> = {
    channels: '渠道配置',
    claude: 'Claude 提供商',
    registration: '注册管理',
    appearance: '外观设置',
    profile: '个人资料',
    'my-channels': '消息通道',
    security: '安全与设备',
    groups: '会话管理',
    memory: '记忆管理',
    skills: '技能管理',
    users: '用户管理',
    about: '关于',
  };

  return (
    <div className="min-h-full bg-slate-50 flex flex-col lg:flex-row">
      {/* Mobile header */}
      <div className="lg:hidden sticky top-0 z-10 flex items-center bg-white border-b border-slate-200 px-4 h-12">
        <button
          onClick={() => setNavOpen(true)}
          className="p-1.5 -ml-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          aria-label="打开导航"
        >
          <Menu className="w-5 h-5 text-slate-600" />
        </button>
        <span className="ml-3 text-sm font-semibold text-slate-900 truncate">{sectionTitle[activeTab]}</span>
      </div>

      {/* Mobile horizontal tab bar */}
      <div
        ref={tabBarRef}
        className="lg:hidden flex items-center gap-1 px-3 py-2 overflow-x-auto bg-white border-b border-slate-200 [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}
      >
        {mobileTabs.map((tab) => {
          const isActive = activeTab === tab.key;
          const disabled = mustChangePassword && tab.key !== 'profile';
          return (
            <button
              key={tab.key}
              data-active={isActive}
              onClick={() => !disabled && handleTabChange(tab.key)}
              disabled={disabled}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                isActive
                  ? 'bg-primary text-white'
                  : disabled
                    ? 'text-slate-300'
                    : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
        <button
          onClick={() => setNavOpen(true)}
          className="flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors whitespace-nowrap cursor-pointer"
        >
          更多...
        </button>
      </div>

      <SettingsNav
        activeTab={activeTab}
        onTabChange={handleTabChange}
        canManageSystemConfig={canManageSystemConfig}
        canManageUsers={!!canManageUsers}
        mustChangePassword={mustChangePassword}
        open={navOpen}
        onOpenChange={setNavOpen}
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
                {activeTab === 'my-channels' && <UserChannelsSection setNotice={setNotice} setError={setError} />}
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
