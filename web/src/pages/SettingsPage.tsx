import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Menu } from 'lucide-react';

import { useAuthStore } from '../stores/auth';
import { SettingsNav } from '../components/settings/SettingsNav';
import { ClaudeProviderSection } from '../components/settings/ClaudeProviderSection';
import { RegistrationSection } from '../components/settings/RegistrationSection';
import { ProfileSection } from '../components/settings/ProfileSection';
import { SecuritySection } from '../components/settings/SecuritySection';
import { AboutSection } from '../components/settings/AboutSection';
import { AppearanceSection } from '../components/settings/AppearanceSection';
import { SystemSettingsSection } from '../components/settings/SystemSettingsSection';
import { UserChannelsSection } from '../components/settings/UserChannelsSection';
import { GroupsPage } from './GroupsPage';
import { MemoryPage } from './MemoryPage';
import { SkillsPage } from './SkillsPage';
import { McpServersPage } from './McpServersPage';
import { PluginsPage } from './PluginsPage';
import { AgentDefinitionsPage } from './AgentDefinitionsPage';
import { UsersPage } from './UsersPage';
import { BindingsSection } from '../components/settings/BindingsSection';
import { UsagePage } from './UsagePage';
import { MonitorPage } from './MonitorPage';
import { Card, CardContent } from '@/components/ui/card';
import type { SettingsTab } from '../components/settings/types';

const VALID_TABS: SettingsTab[] = ['claude', 'registration', 'appearance', 'system', 'profile', 'my-channels', 'security', 'groups', 'memory', 'skills', 'mcp-servers', 'plugins', 'agent-definitions', 'users', 'about', 'bindings', 'usage', 'monitor'];
const SYSTEM_TABS: SettingsTab[] = ['claude', 'registration', 'appearance', 'system'];
const FULLPAGE_TABS: SettingsTab[] = ['groups', 'memory', 'skills', 'mcp-servers', 'plugins', 'agent-definitions', 'users', 'bindings', 'usage', 'monitor'];

export function SettingsPage() {
  const { user: currentUser } = useAuthStore();
  const [searchParams, setSearchParams] = useSearchParams();
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

  const defaultTab: SettingsTab = canManageSystemConfig ? 'claude' : 'profile';

  const activeTab = useMemo((): SettingsTab => {
    if (mustChangePassword) return 'profile';
    const raw = searchParams.get('tab') as SettingsTab | null;
    if (raw && VALID_TABS.includes(raw)) {
      if (SYSTEM_TABS.includes(raw) && !canManageSystemConfig) return defaultTab;
      if (raw === 'monitor' && !canManageSystemConfig) return defaultTab;
      if (raw === 'users' && !canManageUsers) return defaultTab;
      return raw;
    }
    return defaultTab;
  }, [searchParams, canManageSystemConfig, canManageUsers, mustChangePassword, defaultTab]);

  const handleTabChange = useCallback((tab: SettingsTab) => {
    setNavOpen(false);
    setSearchParams({ tab }, { replace: true });
  }, [setSearchParams]);

  // Mobile horizontal tab bar
  const mobileTabs = useMemo(() => {
    const tabs: { key: SettingsTab; label: string }[] = [];
    tabs.push({ key: 'profile', label: '个人偏好' });
    tabs.push({ key: 'my-channels', label: '消息通道' });
    tabs.push({ key: 'security', label: '安全' });
    if (canManageSystemConfig) {
      tabs.push({ key: 'claude', label: 'Claude' });
      tabs.push({ key: 'registration', label: '注册' });
      tabs.push({ key: 'appearance', label: '全局外观' });
      tabs.push({ key: 'system', label: '系统' });
    }
    tabs.push({ key: 'groups', label: '会话' });
    tabs.push({ key: 'memory', label: '记忆' });
    tabs.push({ key: 'skills', label: '技能' });
    tabs.push({ key: 'mcp-servers', label: 'MCP' });
    tabs.push({ key: 'agent-definitions', label: 'Agent' });
    tabs.push({ key: 'bindings', label: 'IM 绑定' });
    tabs.push({ key: 'usage', label: '用量' });
    if (canManageSystemConfig) {
      tabs.push({ key: 'monitor', label: '监控' });
    }
    if (canManageUsers) {
      tabs.push({ key: 'users', label: '用户' });
    }
    tabs.push({ key: 'about', label: '关于' });
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
    claude: 'Claude 提供商',
    registration: '注册管理',
    appearance: '全局外观',
    system: '系统参数',
    profile: '个人偏好',
    'my-channels': '消息通道',
    security: '安全与设备',
    groups: '会话管理',
    memory: '记忆管理',
    skills: '技能(Skill)管理',
    'mcp-servers': 'MCP 服务器',
    plugins: '插件 (Plugins)',
    'agent-definitions': 'Agent 管理',
    users: '用户管理',
    about: '关于',
    bindings: 'IM 绑定',
    usage: '用量统计',
    monitor: '系统监控',
  };

  return (
    <div className="h-full bg-background flex flex-col lg:flex-row overflow-hidden">
      {/* Mobile header */}
      <div
        className="lg:hidden sticky top-0 z-10 flex items-center bg-background border-b border-border px-4 h-12"
      >
        <button
          onClick={() => setNavOpen(true)}
          className="p-1.5 -ml-1.5 rounded-lg hover:bg-muted transition-colors"
          aria-label="打开导航"
        >
          <Menu className="w-5 h-5 text-muted-foreground" />
        </button>
        <span className="ml-3 text-sm font-semibold text-foreground truncate">{sectionTitle[activeTab]}</span>
      </div>

      {/* Mobile horizontal tab bar */}
      <div
        ref={tabBarRef}
        className="lg:hidden flex items-center gap-1 px-3 py-2 overflow-x-auto bg-background border-b border-border [touch-action:pan-x] [&::-webkit-scrollbar]:hidden"
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
                    ? 'text-muted-foreground/50'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
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

      <div className="flex-1 min-w-0 overflow-y-auto">
        {FULLPAGE_TABS.includes(activeTab) ? (
          <>
            {activeTab === 'groups' && <GroupsPage />}
            {activeTab === 'memory' && <MemoryPage />}
            {activeTab === 'skills' && <SkillsPage />}
            {activeTab === 'mcp-servers' && <McpServersPage />}
            {activeTab === 'plugins' && <PluginsPage />}
            {activeTab === 'agent-definitions' && <AgentDefinitionsPage />}
            {activeTab === 'users' && <UsersPage />}
            {activeTab === 'bindings' && <BindingsSection />}
            {activeTab === 'usage' && <UsagePage />}
            {activeTab === 'monitor' && <MonitorPage />}
          </>
        ) : (
          <div className="p-4 lg:p-8">
            <div className="max-w-3xl mx-auto space-y-6">
              <div>
                <h1 className="text-2xl font-bold text-foreground">{sectionTitle[activeTab]}</h1>
              </div>

              {mustChangePassword && (
                <div className="bg-warning-bg border border-warning/20 rounded-xl px-4 py-3 text-sm text-warning">
                  检测到首次登录或管理员重置密码，请先完成"修改密码"，其余关键操作会被暂时限制。
                </div>
              )}

              <Card>
                <CardContent>
                  {activeTab === 'claude' && <ClaudeProviderSection setNotice={() => {}} setError={() => {}} />}
                  {activeTab === 'registration' && <RegistrationSection />}
                  {activeTab === 'appearance' && <AppearanceSection />}
                  {activeTab === 'system' && <SystemSettingsSection />}
                  {activeTab === 'profile' && <ProfileSection />}
                  {activeTab === 'my-channels' && <UserChannelsSection />}
                  {activeTab === 'security' && <SecuritySection />}
                  {activeTab === 'about' && <AboutSection />}
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
