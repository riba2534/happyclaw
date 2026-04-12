import { useState, useEffect, useMemo, useCallback } from 'react';
import { Loader2, Link2, Unlink, MessageSquare, Users, ArrowRightLeft, Info } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/common/SearchInput';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useChatStore } from '../../stores/chat';
import { showToast } from '../../utils/toast';
import type { AgentInfo, AvailableImGroup } from '../../types';
import { ChannelBadge } from '../settings/channel-meta';

interface ImBindingDialogProps {
  open: boolean;
  groupJid: string;
  /** agentId for conversation agent binding; null for main conversation binding */
  agentId: string | null;
  agent?: AgentInfo;
  onClose: () => void;
}

const ACTIVATION_MODE_OPTIONS = [
  { value: 'always', label: '始终响应' },
  { value: 'when_mentioned', label: '仅 @mention' },
  { value: 'owner_mentioned', label: '仅我 @mention' },
] as const;

export function ImBindingDialog({ open, groupJid, agentId, agent, onClose }: ImBindingDialogProps) {
  const [imGroups, setImGroups] = useState<AvailableImGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [rebindTarget, setRebindTarget] = useState<{ imJid: string; group: AvailableImGroup } | null>(null);
  const [activationModes, setActivationModes] = useState<Record<string, string>>({});

  const loadAvailableImGroups = useChatStore((s) => s.loadAvailableImGroups);
  const bindImGroup = useChatStore((s) => s.bindImGroup);
  const unbindImGroup = useChatStore((s) => s.unbindImGroup);
  const bindMainImGroup = useChatStore((s) => s.bindMainImGroup);
  const unbindMainImGroup = useChatStore((s) => s.unbindMainImGroup);

  const isMainMode = agentId === null;

  useEffect(() => {
    if (!open) {
      setLoading(false);
      setActionLoading(null);
      setFilter('');
      setRebindTarget(null);
      setActivationModes({});
      return;
    }

    setActionLoading(null);
    setRebindTarget(null);
    setActivationModes({});
    setLoading(true);
    setFilter('');
    loadAvailableImGroups(groupJid).then((groups) => {
      setImGroups(groups);
      // Initialize activation modes from existing data for feishu groups
      const initial: Record<string, string> = {};
      for (const g of groups) {
        if (g.channel_type === 'feishu' && g.activation_mode && g.activation_mode !== 'auto') {
          initial[g.jid] = g.activation_mode;
        }
      }
      setActivationModes(initial);
      setLoading(false);
    });
  }, [open, groupJid, agentId, loadAvailableImGroups]);

  const filteredGroups = useMemo(() => {
    if (!filter.trim()) return imGroups;
    const q = filter.trim().toLowerCase();
    return imGroups.filter(
      (g) => g.name.toLowerCase().includes(q) || g.jid.toLowerCase().includes(q),
    );
  }, [imGroups, filter]);

  const isBoundToThis = (group: AvailableImGroup): boolean => {
    if (isMainMode) {
      return group.bound_main_jid === groupJid;
    }
    return group.bound_agent_id === agentId;
  };

  const isBoundToOther = (group: AvailableImGroup): boolean => {
    if (isBoundToThis(group)) return false;
    return !!group.bound_agent_id || !!group.bound_main_jid;
  };

  const reloadGroups = async () => {
    try {
      const groups = await loadAvailableImGroups(groupJid);
      setImGroups(groups);
    } catch {
      // ignore — stale list is acceptable
    }
  };

  const handleBind = async (imJid: string) => {
    setActionLoading(imJid);
    try {
      let ok: boolean;
      if (isMainMode) {
        const target = imGroups.find((g) => g.jid === imJid);
        const mode = target?.channel_type === 'feishu' ? (activationModes[imJid] || 'always') : undefined;
        ok = await bindMainImGroup(groupJid, imJid, false, mode);
      } else {
        ok = await bindImGroup(groupJid, agentId, imJid);
      }
      if (ok) {
        await reloadGroups();
      } else {
        showToast('绑定失败');
      }
    } catch {
      showToast('绑定失败');
    }
    setActionLoading(null);
  };

  const handleUnbind = async (imJid: string) => {
    setActionLoading(imJid);
    try {
      let ok: boolean;
      if (isMainMode) {
        ok = await unbindMainImGroup(groupJid, imJid);
      } else {
        ok = await unbindImGroup(groupJid, agentId!, imJid);
      }
      if (ok) {
        await reloadGroups();
      } else {
        showToast('解绑失败');
      }
    } catch {
      showToast('解绑失败');
    }
    setActionLoading(null);
  };

  const handleActivationModeChange = useCallback(async (imJid: string, mode: string) => {
    setActivationModes((prev) => ({ ...prev, [imJid]: mode }));
    // Re-bind with force to update activation_mode on already-bound group
    try {
      await bindMainImGroup(groupJid, imJid, true, mode);
      await reloadGroups();
    } catch {
      showToast('更新触发模式失败');
    }
  }, [groupJid, bindMainImGroup]); // eslint-disable-line react-hooks/exhaustive-deps

  const describeBindTarget = (group: AvailableImGroup): string => {
    if (group.bound_agent_id && group.bound_target_name) {
      return group.bound_workspace_name && group.bound_workspace_name !== group.bound_target_name
        ? `Agent「${group.bound_workspace_name} / ${group.bound_target_name}」`
        : `Agent「${group.bound_target_name}」`;
    }
    if (group.bound_main_jid && group.bound_target_name) {
      return `工作区「${group.bound_target_name}」`;
    }
    return '其他对话';
  };

  const confirmRebind = async () => {
    if (!rebindTarget) return;
    const { imJid, group: rebindGroup } = rebindTarget;
    setRebindTarget(null);
    setActionLoading(imJid);
    try {
      let ok: boolean;
      if (isMainMode) {
        const mode = rebindGroup.channel_type === 'feishu' ? (activationModes[imJid] || 'always') : undefined;
        ok = await bindMainImGroup(groupJid, imJid, true, mode);
      } else {
        ok = await bindImGroup(groupJid, agentId!, imJid, true);
      }
      if (ok) {
        await reloadGroups();
      } else {
        showToast('换绑失败');
      }
    } catch {
      showToast('换绑失败');
    }
    setActionLoading(null);
  };

  const title = isMainMode
    ? '绑定 IM 渠道 — 主对话'
    : `绑定 IM 渠道${agent ? ` — ${agent.name}` : ''}`;

  const renderThreadCapability = (group: AvailableImGroup) => {
    if (!group.is_thread_capable) return null;
    return (
      <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
        话题群
      </span>
    );
  };

  return (<>
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4" />
            {title}
          </DialogTitle>
        </DialogHeader>

        {isMainMode && (
          <div className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            绑定飞书话题群后，工作区会切换为竖向话题列表，每个飞书话题都会自动映射成一个独立会话。
          </div>
        )}

        {/* Filter input — only show when there are groups */}
        {!loading && imGroups.length > 0 && (
          <SearchInput
            value={filter}
            onChange={setFilter}
            placeholder="搜索群组..."
            debounce={150}
          />
        )}

        <div className="space-y-2 max-h-72 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              加载中...
            </div>
          )}

          {!loading && imGroups.length === 0 && (
            <div className="text-center py-8 text-muted-foreground text-sm">
              暂无群聊可绑定。请先在飞书/Telegram/Discord 群中向 Bot 发送消息，群聊会自动出现在此列表中。
              <br />
              <span className="text-xs opacity-70">私聊不支持绑定到子对话。</span>
            </div>
          )}

          {!loading && imGroups.length > 0 && filteredGroups.length === 0 && (
            <div className="text-center py-6 text-muted-foreground text-sm">
              没有匹配的群组
            </div>
          )}

          {!loading &&
            filteredGroups.map((group) => {
              const boundToThis = isBoundToThis(group);
              const boundToOther = isBoundToOther(group);
              const isActioning = actionLoading === group.jid;
              const cannotBindToAgent = !isMainMode && !!group.is_thread_capable;

              return (
                <div
                  key={group.jid}
                  className={`flex items-center gap-3 p-3 rounded-lg border ${
                    boundToThis
                      ? 'border-primary/30 bg-brand-50/50 dark:bg-brand-700/10'
                      : boundToOther
                        ? 'border-amber-200/50 dark:border-amber-800/30'
                        : 'border-border hover:border-border/80'
                  }`}
                >
                  {/* Group avatar */}
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

                  {/* Group info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-medium truncate">{group.name}</div>
                      {renderThreadCapability(group)}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <ChannelBadge channelType={group.channel_type} />
                      {group.member_count != null && (
                        <span className="flex items-center gap-0.5">
                          <Users className="w-3 h-3" />
                          {group.member_count}
                        </span>
                      )}
                      {boundToOther && (
                        <span className="text-amber-500 truncate">
                          已绑定{group.bound_agent_id ? ' Agent' : ''}
                          {group.bound_target_name && `「${
                            group.bound_workspace_name && group.bound_workspace_name !== group.bound_target_name
                              ? `${group.bound_workspace_name} / ${group.bound_target_name}`
                              : group.bound_target_name
                          }」`}
                        </span>
                      )}
                    </div>
                    {cannotBindToAgent && (
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        该群会按飞书话题自动映射，只能绑定到工作区主对话。
                      </div>
                    )}
                  </div>

                  {/* Activation mode selector — only for main mode + unbound feishu group chats */}
                  {isMainMode && group.channel_type === 'feishu' && !boundToThis && !boundToOther && (
                    <div className="flex-shrink-0 flex flex-col items-end gap-1">
                      <select
                        value={activationModes[group.jid] || 'always'}
                        onChange={(e) => setActivationModes((prev) => ({ ...prev, [group.jid]: e.target.value }))}
                        className="text-xs px-1.5 py-1 rounded border border-border bg-background text-foreground"
                      >
                        {ACTIVATION_MODE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      {(activationModes[group.jid] || 'always') === 'owner_mentioned' && (
                        <span className="text-[10px] text-amber-600 dark:text-amber-400 flex items-start gap-0.5 max-w-[140px] leading-tight">
                          <Info className="w-3 h-3 flex-shrink-0 mt-px" />
                          绑定后需在群里发 /owner_mention 注册身份
                        </span>
                      )}
                    </div>
                  )}

                  {/* Action button — three states: unbind / rebind / bind */}
                  {boundToThis ? (
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      {isMainMode && group.channel_type === 'feishu' && (
                        <div className="flex items-center gap-1.5">
                          <select
                            value={activationModes[group.jid] || group.activation_mode || 'always'}
                            onChange={(e) => handleActivationModeChange(group.jid, e.target.value)}
                            className="text-xs px-1.5 py-1 rounded border border-border bg-background text-foreground"
                          >
                            {ACTIVATION_MODE_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      {isMainMode && group.channel_type === 'feishu' &&
                        (activationModes[group.jid] || group.activation_mode || 'always') === 'owner_mentioned' &&
                        !group.owner_im_id && (
                        <span className="text-[10px] text-amber-600 dark:text-amber-400 flex items-start gap-0.5 max-w-[140px] leading-tight">
                          <Info className="w-3 h-3 flex-shrink-0 mt-px" />
                          请在群里发 /owner_mention 注册身份
                        </span>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleUnbind(group.jid)}
                        disabled={isActioning}
                      >
                        {isActioning ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Unlink className="w-3 h-3 mr-1" />
                        )}
                        解绑
                      </Button>
                    </div>
                  ) : boundToOther ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setRebindTarget({ imJid: group.jid, group })}
                      disabled={isActioning}
                      className="flex-shrink-0 text-amber-600 border-amber-300 hover:bg-amber-50 dark:text-amber-400 dark:border-amber-700 dark:hover:bg-amber-950/30"
                    >
                      {isActioning ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <ArrowRightLeft className="w-3 h-3 mr-1" />
                      )}
                      换绑
                    </Button>
                  ) : cannotBindToAgent ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled
                      className="flex-shrink-0"
                    >
                      仅工作区绑定
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => handleBind(group.jid)}
                      disabled={isActioning}
                      className="flex-shrink-0"
                    >
                      {isActioning ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Link2 className="w-3 h-3 mr-1" />
                      )}
                      绑定
                    </Button>
                  )}
                </div>
              );
            })}
        </div>
      </DialogContent>
    </Dialog>

    <ConfirmDialog
      open={!!rebindTarget}
      onClose={() => setRebindTarget(null)}
      onConfirm={confirmRebind}
      title="确认换绑"
      message={rebindTarget ? `该群组当前已绑定到${describeBindTarget(rebindTarget.group)}，确认换绑到当前${isMainMode ? '主对话' : 'Agent'}吗？` : ''}
      confirmText="换绑"
    />
  </>
  );
}
