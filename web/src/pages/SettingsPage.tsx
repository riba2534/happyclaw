import { PhoneBarButton } from '../components/layout/PhonePageHeader';
import {
  lazy,
  Suspense,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import { ChevronLeft, Menu } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { IconButton } from '@/components/common/IconButton';
import { PageContainer } from '@/components/common/PageContainer';
import { useAuthStore } from '../stores/auth';
import { NavDrawerButton } from '../components/layout/NavDrawer';
import { useIsPhone } from '../components/layout/phone';
import { SettingsNav } from '../components/settings/SettingsNav';
import { ClaudeProviderSection } from '../components/settings/ClaudeProviderSection';
import { RegistrationSection } from '../components/settings/RegistrationSection';
import { ProfileSection } from '../components/settings/ProfileSection';
import { PreferencesSection } from '../components/settings/PreferencesSection';
import { SecuritySection } from '../components/settings/SecuritySection';
import { AboutSection } from '../components/settings/AboutSection';
import { AppearanceSection } from '../components/settings/AppearanceSection';
import { MainAgentIdentitySection } from '../components/settings/MainAgentIdentitySection';
import { MainAgentCapabilitiesSection } from '../components/settings/MainAgentCapabilitiesSection';
import {
  HostIntegrationSettingsSection,
  SystemSettingsSection,
} from '../components/settings/SystemSettingsSection';
import { UserChannelsSection } from '../components/settings/UserChannelsSection';
import { GuestsSection } from '../components/settings/GuestsSection';
import { StorageSourcesSection } from '../components/settings/StorageSourcesSection';
import { GUEST_SCOPE_DESCRIPTION, isGuestSettingsTab } from '../lib/guest';
import { UsersPage } from './UsersPage';
import { MonitorPage, MonitorRefreshButton } from './MonitorPage';
import type { SettingsTab } from '../components/settings/types';

const BillingPage = lazy(() => import('./BillingPage'));

const VALID_TABS: SettingsTab[] = [
  'claude',
  'registration',
  'appearance',
  'system',
  'main-agent',
  'host-integration',
  'storage-sources',
  'billing',
  'profile',
  'preferences',
  'my-channels',
  'security',
  'guests',
  'groups',
  'agent-profiles',
  'memory',
  'skills',
  'mcp-servers',
  'plugins',
  'users',
  'about',
  'bindings',
  'usage',
  'monitor',
];
const SYSTEM_TABS: SettingsTab[] = [
  'claude',
  'registration',
  'appearance',
  'system',
  'main-agent',
  'host-integration',
  'storage-sources',
];
// Admin pages embedded under the settings header instead of their own frame.
const EMBEDDED_PAGE_TABS: SettingsTab[] = ['users', 'monitor', 'billing'];
const WIDE_TABS: SettingsTab[] = ['claude', ...EMBEDDED_PAGE_TABS];

const LEGACY_TAB_ROUTES: Partial<Record<SettingsTab, string>> = {
  groups: '/chat',
  'agent-profiles': '/agent-profiles',
  memory: '/memory',
  skills: '/capabilities/skills',
  'mcp-servers': '/capabilities/mcp',
  plugins: '/capabilities/plugins',
  bindings: '/settings?tab=my-channels&view=bindings',
  usage: '/usage',
};

export function SettingsPage() {
  const { user: currentUser } = useAuthStore();
  const hasBillingPermission = useAuthStore((state) =>
    state.hasPermission('manage_billing'),
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const [navOpen, setNavOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const isPhone = useIsPhone();

  const hasSystemConfigPermission =
    currentUser?.role === 'admin' ||
    !!currentUser?.permissions.includes('manage_system_config');
  const mustChangePassword = !!currentUser?.must_change_password;
  const canManageSystemConfig =
    hasSystemConfigPermission && !mustChangePassword;
  const canManageBilling = hasBillingPermission && !mustChangePassword;
  const canManageUsers =
    currentUser?.role === 'admin' ||
    !!currentUser?.permissions.includes('manage_users') ||
    !!currentUser?.permissions.includes('manage_invites') ||
    !!currentUser?.permissions.includes('view_audit_log');

  const isGuest = currentUser?.role === 'guest';
  const defaultTab: SettingsTab = isGuest
    ? 'security'
    : canManageSystemConfig
      ? 'claude'
      : 'profile';
  const rawTabValue = searchParams.get('tab');
  // Keep bookmarks and already-open tabs from the retired automation page on
  // the closest remaining settings surface instead of falling back to models.
  const rawTab = (
    rawTabValue === 'automation' ? 'system' : rawTabValue
  ) as SettingsTab | null;

  const activeTab = useMemo((): SettingsTab => {
    if (mustChangePassword) return 'security';
    const raw = rawTab;
    if (raw && VALID_TABS.includes(raw)) {
      // Guests keep only their own password, devices and local preferences.
      if (isGuest) {
        return isGuestSettingsTab(raw) ? raw : defaultTab;
      }
      if (SYSTEM_TABS.includes(raw) && !canManageSystemConfig)
        return defaultTab;
      if (
        (raw === 'main-agent' ||
          raw === 'host-integration' ||
          raw === 'storage-sources') &&
        currentUser?.role !== 'admin'
      ) {
        return defaultTab;
      }
      if (raw === 'monitor' && !canManageSystemConfig) return defaultTab;
      if (raw === 'billing' && !canManageBilling) return defaultTab;
      if (raw === 'users' && !canManageUsers) return defaultTab;
      return raw;
    }
    return defaultTab;
  }, [
    rawTab,
    canManageSystemConfig,
    canManageUsers,
    canManageBilling,
    mustChangePassword,
    defaultTab,
    currentUser?.role,
    isGuest,
  ]);

  // A phone shows the section list until a section is picked (the URL names
  // it), so the system back gesture returns from a section to the list.
  const showPhoneList = isPhone && !rawTabValue && !mustChangePassword;

  const handleTabChange = useCallback(
    (tab: SettingsTab) => {
      setNavOpen(false);
      if (isPhone) {
        // Pushed, so back pops to the list instead of leaving settings. The
        // entry remembers that the list is behind it, across reloads too.
        setSearchParams({ tab }, { state: { fromSectionList: true } });
      } else {
        setSearchParams({ tab }, { replace: true });
      }
    },
    [isPhone, setSearchParams],
  );

  const backToSectionList = () => {
    if (
      (location.state as { fromSectionList?: boolean } | null)?.fromSectionList
    ) {
      navigate(-1);
    } else {
      // Opened by a link: there is no list entry behind it to pop.
      navigate('/settings', { replace: true });
    }
  };

  const sectionTitle: Record<SettingsTab, string> = {
    claude: '模型配置',
    registration: '注册策略',
    appearance: '常规与品牌',
    system: '运行与容量',
    'main-agent': '主 HappyClaw',
    'host-integration': '宿主机集成',
    'storage-sources': '存储源',
    billing: '计费管理',
    profile: '个人资料',
    preferences: '常规',
    'my-channels': '消息渠道',
    security: '安全与设备',
    guests: '访客',
    groups: '会话管理',
    'agent-profiles': '智能体',
    memory: 'Workspace Memory',
    skills: '技能(Skill)管理',
    'mcp-servers': 'MCP 服务器',
    plugins: '插件 (Plugins)',
    users: '用户与访问',
    about: '关于 HappyClaw',
    bindings: '渠道绑定',
    usage: '用量统计',
    monitor: '运行状态',
  };

  const sectionDescription: Partial<Record<SettingsTab, string>> = {
    profile: '用于标识当前登录用户，不会改变 HappyClaw 或自定义智能体的名称。',
    preferences: '对话行为、界面外观与通知偏好，只保存在当前浏览器。',
    'my-channels': '连接渠道机器人账号，并管理已接入的群聊与会话。',
    security: '修改密码，查看并撤销其他设备上的登录会话。',
    guests: GUEST_SCOPE_DESCRIPTION,
    appearance:
      '系统品牌影响站点标题、欢迎文案和侧边栏 Logo，不会改变 HappyClaw 或自定义智能体的名称。',
    claude: '添加模型连接和它们提供的模型；用哪个模型在智能体和对话里选。',
    system: '管理工作区运行边界、日志和执行容量。',
    registration: '管理注册入口、邀请码，以及登录与注册请求的认证限流策略。',
    'main-agent':
      '管理主智能体的头像、系统附加能力、宿主机配置继承和上下文压缩策略。',
    'host-integration':
      '管理宿主机 Claude 目录以及共享 Plugin Catalog 的来源。',
    'storage-sources':
      'NAS 上的 NFS 导出和 SMB 共享，由 Docker 直接挂进 Container 工作区。',
    billing: '管理计费开关、套餐、用户账务、兑换码与计费审计。',
    users: '管理账户、邀请码与审计日志。',
    monitor: '实时监控系统状态（10秒自动刷新）。',
  };

  const sectionScope: Partial<Record<SettingsTab, string>> = {
    profile: '账户 · 所有设备同步',
    preferences: '仅当前设备',
    'my-channels': '账户 · 所有设备同步',
    security: '账户',
    guests: '账户',
    appearance: '系统 · 全局生效',
    claude: '系统 · 全局生效',
    system: '系统 · 全局生效',
    registration: '系统 · 全局生效',
    'main-agent': '系统 · 管理员',
    'host-integration': '系统 · 管理员',
    'storage-sources': '系统 · 管理员',
    billing: '系统 · 全局生效',
    users: '系统 · 管理后台',
    monitor: '系统 · 管理后台',
  };

  const legacyRoute =
    !mustChangePassword && !isGuest && rawTab
      ? LEGACY_TAB_ROUTES[rawTab]
      : undefined;
  if (legacyRoute) return <Navigate to={legacyRoute} replace />;
  const renderSection = () => (
    <div data-settings-content="true" className="min-w-0 flex-1">
      <PageContainer size={WIDE_TABS.includes(activeTab) ? 'wide' : 'narrow'}>
        <header className="mb-8 flex items-start justify-between gap-4 phone:mb-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {/* A phone names the section in its top bar. */}
              <h1 className="text-title-lg text-foreground phone:hidden">
                {sectionTitle[activeTab]}
              </h1>
              {sectionScope[activeTab] && (
                <Badge variant="neutral">{sectionScope[activeTab]}</Badge>
              )}
            </div>
            {sectionDescription[activeTab] && (
              <p className="mt-1 text-body text-muted-foreground">
                {sectionDescription[activeTab]}
              </p>
            )}
          </div>
          {activeTab === 'monitor' && !isPhone && <MonitorRefreshButton />}
        </header>

        {mustChangePassword && (
          <div
            role="alert"
            className="mb-6 rounded-lg bg-warning/10 px-3 py-2.5 text-body text-warning"
          >
            检测到首次登录或管理员重置密码，请先在“安全与设备”中修改密码；完成前其他设置暂不可用。
          </div>
        )}

        {EMBEDDED_PAGE_TABS.includes(activeTab) ? (
          <>
            {activeTab === 'users' && <UsersPage embedded />}
            {activeTab === 'monitor' && <MonitorPage embedded />}
            {activeTab === 'billing' && (
              <Suspense fallback={null}>
                <BillingPage managementOnly />
              </Suspense>
            )}
          </>
        ) : activeTab === 'system' ? (
          <SystemSettingsSection scope="runtime" />
        ) : activeTab === 'main-agent' ? (
          <div className="space-y-10">
            <MainAgentIdentitySection />
            <MainAgentCapabilitiesSection />
            <HostIntegrationSettingsSection scope="main-agent" />
          </div>
        ) : activeTab === 'host-integration' ? (
          <HostIntegrationSettingsSection scope="host" />
        ) : activeTab === 'storage-sources' ? (
          <StorageSourcesSection />
        ) : (
          <>
            {activeTab === 'claude' && (
              <ClaudeProviderSection
                setNotice={(message) => message && toast.success(message)}
                setError={(message) => message && toast.error(message)}
              />
            )}
            {activeTab === 'registration' && (
              <div className="space-y-10">
                <RegistrationSection />
                <SystemSettingsSection scope="security" />
              </div>
            )}
            {activeTab === 'appearance' && <AppearanceSection />}
            {activeTab === 'profile' && <ProfileSection />}
            {activeTab === 'preferences' && <PreferencesSection />}
            {activeTab === 'my-channels' && <UserChannelsSection />}
            {activeTab === 'security' && <SecuritySection />}
            {activeTab === 'guests' && <GuestsSection />}
            {activeTab === 'about' && <AboutSection />}
          </>
        )}
      </PageContainer>
    </div>
  );

  const navProps = {
    activeTab,
    onTabChange: handleTabChange,
    canManageSystemConfig,
    canManageBilling,
    canManageUsers: !!canManageUsers,
    isAdmin: currentUser?.role === 'admin',
    isGuest,
    mustChangePassword,
  };

  // Phone: a stack. The section list is the settings home; a section opens
  // as its own page with a back button (cindy's settings screens).
  if (isPhone) {
    const phoneBar = (
      title: string,
      leading: ReactNode,
      action?: ReactNode,
    ) => (
      <div className="sticky top-0 z-10 flex h-13 items-center gap-1 border-b border-surface-border bg-background/90 px-2 backdrop-blur">
        {leading}
        <h1 className="min-w-0 flex-1 truncate text-title-sm text-foreground">
          {title}
        </h1>
        {action}
      </div>
    );
    if (showPhoneList) {
      return (
        <div data-settings-page="true" className="min-h-full">
          {phoneBar('设置', <NavDrawerButton />)}
          <SettingsNav {...navProps} variant="page" />
        </div>
      );
    }
    return (
      <div data-settings-page="true" className="min-h-full">
        {phoneBar(
          sectionTitle[activeTab],
          // Until the password is changed there is nowhere else to go.
          mustChangePassword ? (
            <NavDrawerButton />
          ) : (
            <PhoneBarButton
              label="返回"
              icon={<ChevronLeft className="size-6" />}
              onClick={backToSectionList}
            />
          ),
          activeTab === 'monitor' && <MonitorRefreshButton compact />,
        )}
        {renderSection()}
      </div>
    );
  }

  return (
    <div
      data-settings-page="true"
      className="min-h-full lg:flex lg:items-start"
    >
      {/* Narrow desktop header; the menu opens the section sheet. */}
      <div className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b border-surface-border bg-background/90 px-2 backdrop-blur lg:hidden">
        <IconButton
          label="打开导航"
          hideTooltip
          size="icon"
          icon={<Menu className="size-4 text-muted-foreground" />}
          onClick={() => setNavOpen(true)}
        />
        {/* The section title is the h1 below; the bar only names the page. */}
        <span className="truncate text-title-sm text-foreground">设置</span>
      </div>

      <SettingsNav {...navProps} open={navOpen} onOpenChange={setNavOpen} />

      {renderSection()}
    </div>
  );
}
