import { NavLink, useNavigate } from 'react-router-dom';
import { MessageSquare, Clock, Activity, Settings, LogOut } from 'lucide-react';
import { useAuthStore } from '../../stores/auth';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const navItems = [
  { path: '/chat', icon: MessageSquare, label: '聊天' },
  { path: '/tasks', icon: Clock, label: '任务' },
  { path: '/monitor', icon: Activity, label: '监控' },
  { path: '/settings', icon: Settings, label: '设置' },
];

export function NavRail() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  const userInitial = (user?.display_name || user?.username || '?')[0].toUpperCase();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <TooltipProvider delayDuration={200}>
      <nav className="w-16 h-full bg-white border-r border-border flex flex-col items-center py-4 gap-2">
        {/* Logo */}
        <div className="w-10 h-10 rounded-xl overflow-hidden mb-2 flex-shrink-0">
          <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="HappyClaw" className="w-full h-full object-cover" />
        </div>

        {navItems.map(({ path, icon: Icon, label }) => (
          <Tooltip key={path}>
            <TooltipTrigger asChild>
              <NavLink
                to={path}
                className={({ isActive }) =>
                  `w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-0.5 transition-colors ${
                    isActive
                      ? 'bg-brand-50 text-primary'
                      : 'text-muted-foreground hover:bg-accent'
                  }`
                }
              >
                <Icon className="w-5 h-5" />
                <span className="text-xs">{label}</span>
              </NavLink>
            </TooltipTrigger>
            <TooltipContent side="right">
              {label}
            </TooltipContent>
          </Tooltip>
        ))}

        {/* Spacer */}
        <div className="flex-1" />

        {/* User avatar + logout */}
        <div className="flex flex-col items-center gap-1.5 mb-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => navigate('/settings?tab=profile')}
                className="rounded-lg hover:ring-2 hover:ring-brand-200 transition-all cursor-pointer"
              >
                <EmojiAvatar
                  emoji={user?.avatar_emoji}
                  color={user?.avatar_color}
                  fallbackChar={userInitial}
                  size="md"
                  className="w-9 h-9"
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {user?.display_name || user?.username}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleLogout}
                className="w-9 h-9 rounded-lg flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              退出登录
            </TooltipContent>
          </Tooltip>
        </div>
      </nav>
    </TooltipProvider>
  );
}
