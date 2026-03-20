import { Loader2, MessageSquare, Users, ArrowRightLeft, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AvailableImGroup } from '../../types';

const CHANNEL_LABEL: Record<string, string> = {
  feishu: '飞书',
  telegram: 'Telegram',
  qq: 'QQ',
};

const CHANNEL_COLORS: Record<string, string> = {
  feishu: 'bg-blue-100 text-blue-700',
  telegram: 'bg-sky-100 text-sky-700',
  qq: 'bg-purple-100 text-purple-700',  /* IM channel colors are intentionally specific — not semantic tokens */
};

interface ImBindingRowProps {
  group: AvailableImGroup;
  isActioning: boolean;
  onRebind: (group: AvailableImGroup) => void;
  onUnbind: (group: AvailableImGroup) => void;
}

export function ImBindingRow({ group, isActioning, onRebind, onUnbind }: ImBindingRowProps) {
  const hasBound = !!group.bound_agent_id || !!group.bound_main_jid;

  const bindingLabel = (): string => {
    if (group.bound_agent_id && group.bound_target_name) {
      return group.bound_workspace_name && group.bound_workspace_name !== group.bound_target_name
        ? `${group.bound_workspace_name} / ${group.bound_target_name}`
        : group.bound_target_name;
    }
    if (group.bound_main_jid && group.bound_target_name) {
      return `${group.bound_target_name} / 主对话`;
    }
    return '默认（主工作区）';
  };

  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
      hasBound
        ? 'border-brand-200 bg-brand-50/50 dark:border-brand-700/30 dark:bg-brand-700/10'
        : 'border-border'
    }`}>
      {/* Avatar */}
      {group.avatar ? (
        <img
          src={group.avatar}
          alt=""
          className="w-10 h-10 rounded-lg flex-shrink-0 object-cover"
        />
      ) : (
        <div className="w-10 h-10 rounded-lg flex-shrink-0 bg-muted flex items-center justify-center">
          <MessageSquare className="w-5 h-5 text-muted-foreground" />
        </div>
      )}

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{group.name}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${CHANNEL_COLORS[group.channel_type] || 'bg-slate-100 text-slate-600'}`}>
            {CHANNEL_LABEL[group.channel_type] || group.channel_type}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
          {group.member_count != null && (
            <span className="flex items-center gap-0.5">
              <Users className="w-3 h-3" />
              {group.member_count}
            </span>
          )}
          <span className={hasBound ? 'text-primary dark:text-brand-400' : 'text-slate-400'}>
            → {bindingLabel()}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {hasBound && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onUnbind(group)}
            disabled={isActioning}
            className="text-muted-foreground hover:text-error"
          >
            {isActioning ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Unlink className="w-3.5 h-3.5" />
            )}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => onRebind(group)}
          disabled={isActioning}
        >
          {isActioning ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <ArrowRightLeft className="w-3 h-3 mr-1" />
          )}
          换绑
        </Button>
      </div>
    </div>
  );
}
