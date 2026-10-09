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
  const sections = getSettingsSections({
    canManageSystemConfig,
    canManageBilling,
    canManageUsers,
    isAdmin,
  });

  const disabled = (item: NavItem) =>
    mustChangePassword && item.key !== 'security';

  const navigation = (
    <>
      {sections.map((section, index) => (
        <div key={section.label} className={index > 0 ? 'mt-6' : ''}>
          <div className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {section.label}
          </div>
          <div className="space-y-1">
            {section.items.map((item) => (
              <button
                key={item.key}
                type="button"
                disabled={disabled(item)}
                onClick={() => {
                  if (disabled(item)) return;
                  onTabChange(item.key);
                  onOpenChange?.(false);
                }}
                className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                  activeTab === item.key
                    ? 'bg-brand-50 font-medium text-primary'
                    : disabled(item)
                      ? 'cursor-not-allowed text-muted-foreground/50'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                <item.icon className="size-4" />
                {item.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="mt-6 border-t border-border pt-4">
        <button
          type="button"
          disabled={mustChangePassword}
          onClick={() => {
            if (mustChangePassword) return;
            onTabChange(aboutItem.key);
            onOpenChange?.(false);
          }}
          className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
            activeTab === aboutItem.key
              ? 'bg-brand-50 font-medium text-primary'
              : mustChangePassword
                ? 'cursor-not-allowed text-muted-foreground/50'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          <aboutItem.icon className="size-4" />
          {aboutItem.label}
        </button>
      </div>
    </>
  );

  return (
    <>
      <nav className="hidden w-56 shrink-0 border-r border-border bg-background px-3 py-6 lg:sticky lg:top-0 lg:block lg:h-(--app-canvas-h) lg:self-start lg:overflow-y-auto">
        {navigation}
      </nav>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="left"
          className="flex w-64 flex-col p-0"
          showCloseButton={false}
        >
          <SheetHeader className="px-4 pb-2 pt-5">
            <SheetTitle className="text-base">设置</SheetTitle>
            <SheetDescription className="sr-only">
              选择账户、系统配置或管理后台中的设置页面
            </SheetDescription>
          </SheetHeader>
          <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-28">
            {navigation}
          </nav>
        </SheetContent>
      </Sheet>
    </>
  );
}
