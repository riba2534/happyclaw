import {
  MessageCircle,
  Clock4,
  Bot,
  Puzzle,
  BarChart3,
  Brain,
  Wallet,
  Settings,
} from 'lucide-react';

interface NavItem {
  path: string;
  icon: typeof MessageCircle;
  label: string;
  requiresBilling?: boolean;
  hideOnMobile?: boolean;
  /** Read-only guests can open this page. */
  guestVisible?: boolean;
}

export const baseNavItems: NavItem[] = [
  { path: '/chat', icon: MessageCircle, label: '工作台', guestVisible: true },
  { path: '/agent-profiles', icon: Bot, label: '智能体' },
  { path: '/capabilities', icon: Puzzle, label: '能力库' },
  { path: '/tasks', icon: Clock4, label: '任务', guestVisible: true },
  { path: '/usage', icon: BarChart3, label: '用量', hideOnMobile: true },
  {
    path: '/memory',
    icon: Brain,
    label: '记忆',
    hideOnMobile: true,
    guestVisible: true,
  },
  { path: '/billing', icon: Wallet, label: '账单', requiresBilling: true },
  { path: '/settings', icon: Settings, label: '设置', guestVisible: true },
];

export function filterNavItems(billingEnabled: boolean, isGuest = false) {
  return baseNavItems.filter((item) =>
    isGuest ? !!item.guestVisible : !item.requiresBilling || billingEnabled,
  );
}
