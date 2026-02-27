import { MoreHorizontal, Pencil, Trash2, RotateCcw, Star } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useAuthStore } from '../../stores/auth';

export interface ChatGroupItemProps {
  jid: string;
  name: string;
  folder: string;
  lastMessage?: string;
  executionMode?: 'container' | 'host';
  isShared?: boolean;
  memberRole?: 'owner' | 'member';
  memberCount?: number;
  isActive: boolean;
  isHome: boolean;
  editable?: boolean;
  deletable?: boolean;
  onSelect: (jid: string, folder: string) => void;
  onRename?: (jid: string, name: string) => void;
  onClearHistory: (jid: string, name: string) => void;
  onDelete?: (jid: string, name: string) => void;
}

export function ChatGroupItem({
  jid,
  name,
  folder,
  lastMessage,
  executionMode,
  isShared,
  memberRole,
  memberCount,
  isActive,
  isHome,
  editable,
  deletable,
  onSelect,
  onRename,
  onClearHistory,
  onDelete,
}: ChatGroupItemProps) {
  const currentUser = useAuthStore((s) => s.user);
  const defaultHomeName = '我的工作区';
  // Use actual name if it's been renamed, otherwise fall back to default
  const isDefaultName = !name || name === 'Main' || name === `${currentUser?.username} Home`;
  const displayName = isHome && isDefaultName ? defaultHomeName : name;
  const truncatedMsg =
    lastMessage && lastMessage.length > 40
      ? lastMessage.substring(0, 40) + '...'
      : lastMessage;

  return (
    <div
      className={cn(
        'group relative rounded-lg mb-0.5 transition-colors',
        isActive
          ? 'bg-accent max-lg:bg-white/55 max-lg:backdrop-blur-lg max-lg:saturate-[1.8] max-lg:border max-lg:border-white/35 max-lg:shadow-[0_8px_32px_rgba(0,0,0,0.06),inset_0_1px_1px_rgba(255,255,255,0.6)]'
          : 'hover:bg-accent/50',
      )}
    >
      <button
        onClick={() => onSelect(jid, folder)}
        className="w-full text-left px-3 pr-12 py-2.5 cursor-pointer"
      >
        <div className="flex items-center gap-1.5">
          {isHome && (
            <Star className="w-3.5 h-3.5 text-yellow-500 fill-yellow-500 flex-shrink-0" />
          )}
          <span
            className={cn(
              'text-sm truncate',
              isActive ? 'font-semibold text-foreground' : 'text-muted-foreground',
            )}
          >
            {displayName}
          </span>
          {executionMode === 'host' ? (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700">
              宿主机
            </span>
          ) : executionMode === 'container' ? (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-sky-100 text-sky-700">
              Docker
            </span>
          ) : null}
          {isShared && memberRole === 'owner' && (memberCount ?? 0) >= 2 && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-700">
              Owner
            </span>
          )}
          {isShared && memberRole !== 'owner' && (memberCount ?? 0) >= 2 && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-100 text-violet-700">
              {memberCount}人协作
            </span>
          )}
        </div>
        {truncatedMsg && (
          <p className={cn('text-xs text-muted-foreground/70 truncate mt-0.5', isHome && 'pl-5')}>
            {truncatedMsg}
          </p>
        )}
      </button>

      {/* Dropdown menu */}
      <div
        className={cn(
          'absolute right-2 top-1/2 -translate-y-1/2 flex items-center',
          'opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity',
        )}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {editable && onRename && (
              <DropdownMenuItem onClick={() => onRename(jid, name)}>
                <Pencil className="w-4 h-4" />
                重命名
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => onClearHistory(jid, displayName)}
              className="text-amber-700 focus:text-amber-700"
            >
              <RotateCcw className="w-4 h-4" />
              重建工作区
            </DropdownMenuItem>
            {!isHome && deletable && onDelete && (
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onDelete(jid, name)}
              >
                <Trash2 className="w-4 h-4" />
                删除
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
