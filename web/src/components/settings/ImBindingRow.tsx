import {
  Loader2,
  MessageSquare,
  Users,
  ArrowRightLeft,
  RotateCcw,
  AlertTriangle,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { IconButton } from '@/components/common/IconButton';
import type { AvailableImGroup } from '../../types';
import { ChannelAccountBadge, ChannelBadge } from './channel-meta';
import {
  ACTIVATION_MODE_OPTIONS,
  AUDIENCE_MODE_OPTIONS,
} from '../../constants/im';
import {
  hasBindingPolicyMismatch,
  resolveBindingTargetType,
} from '../../utils/im-binding-policy';
import { getImChannelCapabilities } from '../../constants/im-capabilities';

interface ImBindingRowProps {
  group: AvailableImGroup;
  isActioning: boolean;
  onRebind: (group: AvailableImGroup) => void;
  onUnbind: (group: AvailableImGroup) => void;
  onResetAllowlist: (group: AvailableImGroup) => void;
  onActivationModeChange: (jid: string, mode: string) => void;
  onAudienceModeChange: (jid: string, mode: 'everyone' | 'owner_only') => void;
  onDelete: (group: AvailableImGroup) => void;
}

export function ImBindingRow({
  group,
  isActioning,
  onRebind,
  onUnbind,
  onResetAllowlist,
  onActivationModeChange,
  onAudienceModeChange,
  onDelete,
}: ImBindingRowProps) {
  const boundSessionId = group.bound_session_id ?? group.bound_agent_id;
  const boundWorkspaceJid = group.bound_workspace_jid ?? group.bound_main_jid;
  const hasBound = !!boundSessionId || !!boundWorkspaceJid;
  const policyMismatch = hasBindingPolicyMismatch(group);
  const supportsActivation =
    (group.conversation_kind === 'group' ||
      group.conversation_kind === 'topic') &&
    !policyMismatch &&
    getImChannelCapabilities(group.channel_type)?.supports_activation_modes ===
      true;
  const supportsOwnerMention =
    getImChannelCapabilities(group.channel_type)?.supports_owner_mention ===
    true;
  const activationModeOptions = ACTIVATION_MODE_OPTIONS.filter(
    (option) =>
      (option.value !== 'owner_mentioned' || supportsOwnerMention) &&
      !(group.channel_type === 'feishu' && option.value === 'owner_mentioned'),
  );
  // Empty array = "owner-locked trap": bot was added before Feishu owner DM'd it,
  // so nobody (not even the owner) can trigger the bot until allowlist is reset
  // or owner sends a DM (which auto-backfills via learnFeishuOwner).
  const isAllowlistLocked =
    group.channel_type === 'feishu' && group.sender_allowlist_locked === true;

  const bindingLabel = (): string => {
    if (boundSessionId && group.bound_target_name) {
      const target =
        group.bound_workspace_name &&
        group.bound_workspace_name !== group.bound_target_name
          ? `${group.bound_workspace_name} / ${group.bound_target_name}`
          : group.bound_target_name;
      return !policyMismatch ? `会话 · ${target}` : `异常会话绑定 · ${target}`;
    }
    if (boundWorkspaceJid && group.bound_target_name) {
      return resolveBindingTargetType(group) === 'session'
        ? `主会话 · ${group.bound_target_name}`
        : `工作区 · ${group.bound_target_name}`;
    }
    return '未绑定';
  };

  const showAudience =
    group.channel_type === 'feishu' &&
    (group.conversation_kind === 'group' ||
      group.conversation_kind === 'topic') &&
    !policyMismatch;

  return (
    <div role="listitem" className="px-4 py-3">
      <div className="flex items-start gap-3">
        {/* Avatar */}
        {group.avatar ? (
          <img
            src={group.avatar}
            alt=""
            className="size-8 shrink-0 rounded-lg object-cover ring-1 ring-surface-border"
          />
        ) : (
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-surface-border">
            <MessageSquare className="size-4" />
          </div>
        )}

        {/* Info */}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate text-body font-medium text-foreground">
              {group.name}
            </span>
            <ChannelBadge channelType={group.channel_type} />
            <ChannelAccountBadge
              accountId={group.channel_account_id}
              accountName={group.channel_account_name}
            />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-caption text-muted-foreground">
            <span>
              {group.conversation_kind === 'direct'
                ? '私聊'
                : group.conversation_kind === 'group'
                  ? '普通群'
                  : group.conversation_kind === 'topic'
                    ? '话题群'
                    : '类型待确认'}
            </span>
            {group.member_count != null && (
              <span className="flex items-center gap-0.5 tabular-nums">
                <Users className="size-3" />
                {group.member_count}
              </span>
            )}
            <span
              className={hasBound ? 'text-foreground' : 'text-faint-foreground'}
            >
              → {bindingLabel()}
            </span>
          </div>
          {isAllowlistLocked && (
            <div className="mt-1.5 flex flex-wrap items-start gap-x-2 gap-y-1 text-caption text-warning">
              <span className="flex min-w-0 flex-1 items-start gap-1">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                <span>
                  发言者白名单为空，bot 无法响应任何人。请向 bot
                  发条私聊以认领群聊，或点击右侧「重置」清空白名单。
                </span>
              </span>
              <Button
                size="xs"
                variant="outline"
                onClick={() => onResetAllowlist(group)}
                disabled={isActioning}
                className="text-warning hover:text-warning"
              >
                {isActioning ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <AlertTriangle />
                )}
                解除限制
              </Button>
            </div>
          )}
          {policyMismatch && (
            <div className="mt-1.5 flex items-start gap-1 text-caption text-warning">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <span>
                此绑定与渠道类型不符：私聊和普通群绑定会话，话题群绑定工作区。
              </span>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-0.5">
          {hasBound && (
            <IconButton
              label="解除渠道绑定"
              onClick={() => onUnbind(group)}
              disabled={isActioning}
              className="text-muted-foreground"
              icon={
                isActioning ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="size-3.5" />
                )
              }
            />
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => onRebind(group)}
            disabled={isActioning}
            className="mx-1"
          >
            {isActioning ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ArrowRightLeft className="size-3.5" />
            )}
            {hasBound ? '换绑' : '绑定'}
          </Button>
          <IconButton
            label="删除（群已不存在/bot 已被踢时使用）"
            onClick={() => onDelete(group)}
            disabled={isActioning}
            className="text-muted-foreground hover:text-error"
            icon={
              isActioning ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )
            }
          />
        </div>
      </div>

      {(supportsActivation || showAudience) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 sm:pl-11">
          {supportsActivation && (
            <NativeSelect
              size="sm"
              className="max-w-full"
              value={
                group.channel_type === 'feishu' &&
                group.activation_mode === 'owner_mentioned'
                  ? 'when_mentioned'
                  : group.activation_mode || 'auto'
              }
              onChange={(e) =>
                onActivationModeChange(group.jid, e.target.value)
              }
              disabled={isActioning}
              aria-label={`${group.name} 的消息响应方式`}
              title="消息响应方式"
            >
              {activationModeOptions.map((o) => (
                <NativeSelectOption key={o.value} value={o.value}>
                  {o.value === 'auto'
                    ? `${o.label}（当前：${group.require_mention ? '仅 @机器人' : '所有允许成员'}）`
                    : o.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
          {showAudience && (
            <NativeSelect
              size="sm"
              className="max-w-full"
              value={
                group.audience_mode === 'owner_only' ||
                group.activation_mode === 'owner_mentioned'
                  ? 'owner_only'
                  : 'everyone'
              }
              onChange={(e) =>
                onAudienceModeChange(
                  group.jid,
                  e.target.value as 'everyone' | 'owner_only',
                )
              }
              disabled={isActioning}
              aria-label={`${group.name} 的响应对象`}
              title="响应对象"
            >
              {AUDIENCE_MODE_OPTIONS.map((option) => (
                <NativeSelectOption key={option.value} value={option.value}>
                  {option.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </div>
      )}
    </div>
  );
}
