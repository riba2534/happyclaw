import { MessageCircle, Clock4, Puzzle, Wallet, User, ThumbsUp } from 'lucide-react';
import type { Permission } from '@/stores/auth';

export const baseNavItems = [
  { path: '/chat', icon: MessageCircle, label: '工作台' },
  { path: '/skills', icon: Puzzle, label: 'Skill' },
  { path: '/tasks', icon: Clock4, label: '任务' },
  { path: '/feedback', icon: ThumbsUp, label: '反馈', requiresPermission: 'view_audit_log' as Permission },
  { path: '/billing', icon: Wallet, label: '账单', requiresBilling: true },
  { path: '/settings', icon: User, label: '设置' },
];

export function filterNavItems(
  billingEnabled: boolean,
  hasPermission?: (p: Permission) => boolean,
) {
  return baseNavItems.filter((item) => {
    if (item.requiresBilling && !billingEnabled) return false;
    if (item.requiresPermission && hasPermission && !hasPermission(item.requiresPermission)) return false;
    return true;
  });
}
