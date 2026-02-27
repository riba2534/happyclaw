import {
  Radio,
  ShieldCheck,
  UserPlus,
  User,
  Shield,
  Layers,
  BookOpen,
  Puzzle,
  Server,
  UserCog,
  Info,
  Palette,
  MessageSquare,
  SlidersHorizontal,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { SettingsTab } from './types';

interface NavItem {
  key: SettingsTab;
  label: string;
  icon: React.ReactNode;
  group: 'system' | 'account' | 'features';
}

const systemItems: NavItem[] = [
  { key: 'channels', label: '系统渠道', icon: <Radio className="w-4 h-4" />, group: 'system' },
  { key: 'claude', label: 'Claude 提供商', icon: <ShieldCheck className="w-4 h-4" />, group: 'system' },
  { key: 'registration', label: '注册管理', icon: <UserPlus className="w-4 h-4" />, group: 'system' },
  { key: 'appearance', label: '外观（全局）', icon: <Palette className="w-4 h-4" />, group: 'system' },
  { key: 'system', label: '系统参数', icon: <SlidersHorizontal className="w-4 h-4" />, group: 'system' },
];

const accountItems: NavItem[] = [
  { key: 'profile', label: '个人资料', icon: <User className="w-4 h-4" />, group: 'account' },
  { key: 'my-channels', label: '我的通道', icon: <MessageSquare className="w-4 h-4" />, group: 'account' },
  { key: 'security', label: '安全与设备', icon: <Shield className="w-4 h-4" />, group: 'account' },
];

const featureItems: NavItem[] = [
  { key: 'groups', label: '会话管理', icon: <Layers className="w-4 h-4" />, group: 'features' },
  { key: 'memory', label: '记忆管理', icon: <BookOpen className="w-4 h-4" />, group: 'features' },
  { key: 'skills', label: '技能管理', icon: <Puzzle className="w-4 h-4" />, group: 'features' },
  { key: 'mcp-servers', label: 'MCP 服务器', icon: <Server className="w-4 h-4" />, group: 'features' },
  { key: 'users', label: '用户管理', icon: <UserCog className="w-4 h-4" />, group: 'features' },
  { key: 'about', label: '关于', icon: <Info className="w-4 h-4" />, group: 'features' },
];

interface SettingsNavProps {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  canManageSystemConfig: boolean;
  canManageUsers: boolean;
  mustChangePassword: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SettingsNav({ activeTab, onTabChange, canManageSystemConfig, canManageUsers, mustChangePassword, open, onOpenChange }: SettingsNavProps) {
  const visibleItems: { group: string; items: NavItem[] }[] = [];

  if (canManageSystemConfig) {
    visibleItems.push({ group: '系统配置', items: systemItems });
  }
  visibleItems.push({ group: '账户设置', items: accountItems });

  const visibleFeatures = featureItems.filter((item) => {
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

      {/* Mobile: left sheet drawer */}
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="left" className="w-64 p-0" showCloseButton={false}>
          <SheetHeader className="px-4 pt-5 pb-2">
            <SheetTitle className="text-base">设置</SheetTitle>
          </SheetHeader>
          <nav className="px-3 pb-4 overflow-y-auto">
            {visibleItems.map((section, si) => (
              <div key={section.group} className={si > 0 ? 'mt-5' : ''}>
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
                        onClick={() => {
                          if (!disabled) {
                            onTabChange(item.key);
                            onOpenChange?.(false);
                          }
                        }}
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
        </SheetContent>
      </Sheet>
    </>
  );
}
