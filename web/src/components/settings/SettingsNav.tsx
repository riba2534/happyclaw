import {
  Radio,
  ShieldCheck,
  UserPlus,
  User,
  Shield,
  Layers,
  BookOpen,
  Puzzle,
  UserCog,
  Info,
  Palette,
} from 'lucide-react';
import type { SettingsTab } from './types';

interface NavItem {
  key: SettingsTab;
  label: string;
  icon: React.ReactNode;
  group: 'system' | 'account' | 'features';
}

const systemItems: NavItem[] = [
  { key: 'channels', label: '渠道配置', icon: <Radio className="w-4 h-4" />, group: 'system' },
  { key: 'claude', label: 'Claude 提供商', icon: <ShieldCheck className="w-4 h-4" />, group: 'system' },
  { key: 'registration', label: '注册管理', icon: <UserPlus className="w-4 h-4" />, group: 'system' },
  { key: 'appearance', label: '外观设置', icon: <Palette className="w-4 h-4" />, group: 'system' },
];

const accountItems: NavItem[] = [
  { key: 'profile', label: '个人资料', icon: <User className="w-4 h-4" />, group: 'account' },
  { key: 'security', label: '安全与设备', icon: <Shield className="w-4 h-4" />, group: 'account' },
];

const featureItems: NavItem[] = [
  { key: 'groups', label: '会话管理', icon: <Layers className="w-4 h-4" />, group: 'features' },
  { key: 'memory', label: '记忆管理', icon: <BookOpen className="w-4 h-4" />, group: 'features' },
  { key: 'skills', label: '技能管理', icon: <Puzzle className="w-4 h-4" />, group: 'features' },
  { key: 'users', label: '用户管理', icon: <UserCog className="w-4 h-4" />, group: 'features' },
  { key: 'about', label: '关于', icon: <Info className="w-4 h-4" />, group: 'features' },
];

interface SettingsNavProps {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  canManageSystemConfig: boolean;
  canManageUsers: boolean;
  mustChangePassword: boolean;
}

export function SettingsNav({ activeTab, onTabChange, canManageSystemConfig, canManageUsers, mustChangePassword }: SettingsNavProps) {
  const visibleItems: { group: string; items: NavItem[] }[] = [];

  if (canManageSystemConfig) {
    visibleItems.push({ group: '系统配置', items: systemItems });
  }
  visibleItems.push({ group: '账户设置', items: accountItems });

  const visibleFeatures = featureItems.filter((item) => {
    if (item.key === 'memory' && !canManageSystemConfig) return false;
    if (item.key === 'users' && !canManageUsers) return false;
    return true;
  });
  if (visibleFeatures.length > 0) {
    visibleItems.push({ group: '更多功能', items: visibleFeatures });
  }

  const isDisabled = (item: NavItem) => mustChangePassword && item.key !== 'profile';

  return (
    <>
      {/* Desktop: vertical sidebar */}
      <nav className="hidden lg:block w-56 shrink-0 bg-white border-r border-slate-200 py-6 px-3">
        {visibleItems.map((section, si) => (
          <div key={section.group} className={si > 0 ? 'mt-6' : ''}>
            <div className="px-3 mb-2 text-xs font-semibold text-slate-400 uppercase tracking-wider">
              {section.group}
            </div>
            <div className="space-y-1">
              {section.items.map((item) => {
                const active = activeTab === item.key;
                const disabled = isDisabled(item);
                return (
                  <button
                    key={item.key}
                    onClick={() => !disabled && onTabChange(item.key)}
                    disabled={disabled}
                    className={`w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors cursor-pointer ${
                      active
                        ? 'bg-brand-50 text-primary font-medium'
                        : disabled
                          ? 'text-slate-300 cursor-not-allowed'
                          : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                    }`}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Mobile: horizontal scrollable tabs */}
      <nav className="lg:hidden sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-2 overflow-x-auto">
        <div className="flex gap-1 min-w-max">
          {visibleItems.flatMap((section) => section.items).map((item) => {
            const active = activeTab === item.key;
            const disabled = isDisabled(item);
            return (
              <button
                key={item.key}
                onClick={() => !disabled && onTabChange(item.key)}
                disabled={disabled}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg whitespace-nowrap transition-colors cursor-pointer ${
                  active
                    ? 'bg-brand-50 text-primary font-medium'
                    : disabled
                      ? 'text-slate-300 cursor-not-allowed'
                      : 'text-slate-500 hover:bg-slate-50'
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
}
