import { MessageSquare, Clock, Activity, Settings, BarChart3, CreditCard } from 'lucide-react';

export const baseNavItems = [
  { path: '/chat', icon: MessageSquare, label: '工作台' },
  { path: '/tasks', icon: Clock, label: '任务' },
  { path: '/usage', icon: BarChart3, label: '用量' },
  { path: '/billing', icon: CreditCard, label: '账单', requiresBilling: true },
  { path: '/monitor', icon: Activity, label: '监控', requireAdmin: true },
  { path: '/settings', icon: Settings, label: '设置' },
];
