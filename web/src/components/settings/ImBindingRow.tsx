import { Loader2, MessageSquare, Users, ArrowRightLeft, Unlink, AlertTriangle, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AvailableImGroup } from '../../types';
import { ChannelBadge } from './channel-meta';
import { ACTIVATION_MODE_OPTIONS } from '../../constants/im';

interface ImBindingRowProps {
  group: AvailableImGroup;
  isActioning: boolean;
  onRebind: (group: AvailableImGroup) => void;
  onUnbind: (group: AvailableImGroup) => void;
  onResetAllowlist: (group: AvailableImGroup) => void;
  onActivationModeChange: (jid: string, mode: string) => void;
  onDelete: (group: AvailableImGroup) => void;
}

export function ImBindingRow({ group, isActioning, onRebind, onUnbind, onResetAllowlist, onActivationModeChange, onDelete }: ImBindingRowProps) {
  const hasBound = !!group.bound_agent_id || !!group.bound_main_jid;
  // Empty array = "owner-locked trap": bot was added before Feishu owner DM'd it,
  // so nobody (not even the owner) can trigger the bot until allowlist is reset
  // or owner sends a DM (which auto-backfills via learnFeishuOwner).
  const isAllowlistLocked = group.sender_allowlist_locked === true;

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
      isAllowlistLocked
        ? 'border-amber-300 bg-amber-50/50 dark:border-amber-700/40 dark:bg-amber-900/10'
        : hasBound
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
          <ChannelBadge channelType={group.channel_type} />
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
          {group.member_count != null && (
            <span className="flex items-center gap-0.5">
              <Users className="w-3 h-3" />
              {group.member_count}
            </span>
          )}
          <span className={hasBound ? 'text-primary dark:text-brand-400' : 'text-muted-foreground'}>
            → {bindingLabel()}
          </span>
        </div>
        {isAllowlistLocked && (
          <div className="flex items-start gap-1 mt-1 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
            <span>
              发言者白名单为空，bot 无法响应任何人。请向 bot 发条私聊以认领群聊，或点击右侧「重置」清空白名单。
            </span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {isAllowlistLocked && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onResetAllowlist(group)}
            disabled={isActioning}
            className="text-amber-700 border-amber-300 hover:bg-amber-100 dark:text-amber-400 dark:border-amber-700 dark:hover:bg-amber-900/30"
          >
            {isActioning ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <AlertTriangle className="w-3 h-3 mr-1" />
            )}
            重置白名单
          </Button>
        )}
        {hasBound && (
          <div className="flex items-center gap-1.5">
            <select
              value={group.activation_mode || 'auto'}
              onChange={(e) => onActivationModeChange(group.jid, e.target.value)}
              disabled={isActioning}
              className="text-xs px-1.5 py-1 rounded border border-border bg-background text-foreground disabled:opacity-50"
            >
              {ACTIVATION_MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        )}
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
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onDelete(group)}
          disabled={isActioning}
          className="text-muted-foreground hover:text-error"
          title="删除（群已不存在/bot 已被踢时使用）"
        >
          {isActioning ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Trash2 className="w-3.5 h-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}
