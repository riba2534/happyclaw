import { MessageCircle, Clock4, Puzzle, Wallet, User } from 'lucide-react';

export const baseNavItems = [
  { path: '/chat', icon: MessageCircle, label: '工作台' },
  { path: '/skills', icon: Puzzle, label: 'Skill' },
  { path: '/tasks', icon: Clock4, label: '任务' },
  { path: '/billing', icon: Wallet, label: '账单', requiresBilling: true },
  { path: '/settings', icon: User, label: '设置' },
];
