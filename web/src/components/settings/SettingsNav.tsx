import { useState } from 'react';
import {
  CreditCard,
  Gauge,
  Info,
  MessageSquare,
  Palette,
  Shield,
  ShieldCheck,
  Bot,
  ServerCog,
  Settings2,
  SlidersHorizontal,
  User,
  UserCog,
  UserPlus,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { SearchInput } from '@/components/common/SearchInput';
import { sidebarRowClass } from '@/components/layout/sidebar/SidebarItem';
import { cn } from '@/lib/utils';
import type { SettingsTab } from './types';

export interface SettingsNavItem {
  key: SettingsTab;
  label: string;
  icon: LucideIcon;
}
type NavItem = SettingsNavItem;

const accountItems: NavItem[] = [
  { key: 'profile', label: '个人资料', icon: User },
  {
    key: 'preferences',
    label: '常规',
    icon: Settings2,
  },
  {
    key: 'my-channels',
    label: '消息渠道',
    icon: MessageSquare,
  },
  { key: 'security', label: '安全与设备', icon: Shield },
];

const systemItems: NavItem[] = [
  {
    key: 'appearance',
    label: '常规与品牌',
    icon: Palette,
  },
  {
    key: 'claude',
    label: '模型配置',
    icon: ShieldCheck,
  },
  {
    key: 'main-agent',
    label: '主 HappyClaw',
    icon: Bot,
  },
  {
    key: 'system',
    label: '执行与容量',
    icon: SlidersHorizontal,
  },
  {
    key: 'host-integration',
    label: '宿主机集成',
    icon: ServerCog,
  },
  {
    key: 'billing',
    label: '计费管理',
    icon: CreditCard,
  },
];

const managementItems: NavItem[] = [
  {
    key: 'registration',
    label: '注册策略',
    icon: UserPlus,
  },
  { key: 'users', label: '用户与访问', icon: UserCog },
  { key: 'monitor', label: '运行状态', icon: Gauge },
];

export const aboutItem: NavItem = {
  key: 'about',
  label: '关于 HappyClaw',
  icon: Info,
};

export interface SettingsPermissions {
  canManageSystemConfig: boolean;
  canManageBilling: boolean;
  canManageUsers: boolean;
  isAdmin: boolean;
}

/** Settings sections visible to the current user (also used by ⌘K). */
export function getSettingsSections({
  canManageSystemConfig,
  canManageBilling,
  canManageUsers,
  isAdmin,
}: SettingsPermissions): { label: string; items: NavItem[] }[] {
  const system = systemItems.filter((item) => {
    if (item.key === 'billing') return canManageBilling;
    if (item.key === 'main-agent' || item.key === 'host-integration') {
      return isAdmin;
    }
    return canManageSystemConfig;
  });
  const management = managementItems.filter((item) => {
    if (item.key === 'users') return canManageUsers;
    return canManageSystemConfig;
  });
  return [
    { label: '账户设置', items: accountItems },
    ...(system.length ? [{ label: '系统配置', items: system }] : []),
    ...(management.length ? [{ label: '管理后台', items: management }] : []),
  ];
}

interface SettingsNavProps {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  canManageSystemConfig: boolean;
  canManageBilling: boolean;
  canManageUsers: boolean;
  isAdmin: boolean;
  mustChangePassword: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const navRowClass = cn(sidebarRowClass, 'gap-2.5 pointer-coarse:h-11');

export function SettingsNav({
  activeTab,
  onTabChange,
  canManageSystemConfig,
  canManageBilling,
  canManageUsers,
  isAdmin,
  mustChangePassword,
  open,
  onOpenChange,
}: SettingsNavProps) {
  const [query, setQuery] = useState('');
  const sections = getSettingsSections({
    canManageSystemConfig,
    canManageBilling,
    canManageUsers,
    isAdmin,
  });

  const keyword = query.trim().toLowerCase();
  const matches = (item: NavItem) =>
    !keyword || item.label.toLowerCase().includes(keyword);
  const visibleSections = sections
    .map((section) => ({ ...section, items: section.items.filter(matches) }))
    .filter((section) => section.items.length > 0);
  const showAbout = matches(aboutItem);

  const disabled = (item: NavItem) =>
    mustChangePassword && item.key !== 'security';

  const renderItem = (item: NavItem) => (
    <button
      key={item.key}
      type="button"
      disabled={disabled(item)}
      aria-current={activeTab === item.key ? 'page' : undefined}
      data-active={activeTab === item.key || undefined}
      onClick={() => {
        if (disabled(item)) return;
        onTabChange(item.key);
        onOpenChange?.(false);
      }}
      className={navRowClass}
    >
      <item.icon className="size-4" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
    </button>
  );

  const search = (
    <SearchInput
      value={query}
      onChange={setQuery}
      debounce={0}
      placeholder="搜索设置"
      ariaLabel="搜索设置项"
    />
  );

  const navigation = (
    <>
      {visibleSections.map((section, index) => (
        <div key={section.label} className={index > 0 ? 'mt-5' : ''}>
          <div className="mb-1 px-2 text-caption font-medium text-muted-foreground">
            {section.label}
          </div>
          <div className="space-y-px">{section.items.map(renderItem)}</div>
        </div>
      ))}
      {showAbout && (
        <div
          className={
            visibleSections.length > 0
              ? 'mt-5 border-t border-surface-border pt-3'
              : ''
          }
        >
          {renderItem(aboutItem)}
        </div>
      )}
      {visibleSections.length === 0 && !showAbout && (
        <p className="px-2 py-6 text-center text-caption text-muted-foreground">
          没有匹配的设置
        </p>
      )}
    </>
  );

  return (
    <>
      <nav
        aria-label="设置导航"
        className="hidden w-60 shrink-0 flex-col border-r border-surface-border lg:sticky lg:top-0 lg:flex lg:h-(--app-canvas-h) lg:self-start"
      >
        <div className="space-y-3 px-3 pt-5 pb-3">
          <h2 className="px-2 text-title text-foreground">设置</h2>
          {search}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
          {navigation}
        </div>
      </nav>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="left"
          className="flex w-72 flex-col gap-0 p-0"
          showCloseButton={false}
        >
          <SheetHeader className="gap-3 px-3 pt-5 pb-3">
            <SheetTitle className="px-2 text-title">设置</SheetTitle>
            <SheetDescription className="sr-only">
              选择账户、系统配置或管理后台中的设置页面
            </SheetDescription>
            {search}
          </SheetHeader>
          <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-28">
            {navigation}
          </nav>
        </SheetContent>
      </Sheet>
    </>
  );
}
