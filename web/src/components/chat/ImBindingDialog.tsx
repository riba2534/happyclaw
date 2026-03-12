import { useState, useEffect, useMemo } from 'react';
import { Loader2, Link2, Unlink, MessageSquare, Users, ArrowRightLeft } from 'lucide-react';
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

interface ImBindingDialogProps {
  open: boolean;
  groupJid: string;
  /** agentId for conversation agent binding; null for main conversation binding */
  agentId: string | null;
  agent?: AgentInfo;
  onClose: () => void;
}

const CHANNEL_LABEL: Record<string, string> = {
  feishu: '飞书群聊',
  telegram: 'Telegram',
};

export function ImBindingDialog({ open, groupJid, agentId, agent, onClose }: ImBindingDialogProps) {
  const [imGroups, setImGroups] = useState<AvailableImGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [rebindTarget, setRebindTarget] = useState<{ imJid: string; group: AvailableImGroup } | null>(null);

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
      return;
    }

    setActionLoading(null);
    setRebindTarget(null);
    setLoading(true);
    setFilter('');
    loadAvailableImGroups(groupJid).then((groups) => {
      setImGroups(groups);
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
        ok = await bindMainImGroup(groupJid, imJid);
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
    const { imJid } = rebindTarget;
    setRebindTarget(null);
    setActionLoading(imJid);
    try {
      let ok: boolean;
      if (isMainMode) {
        ok = await bindMainImGroup(groupJid, imJid, true);
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
    ? '绑定 IM 群组 — 主对话'
    : `绑定 IM 群组${agent ? ` — ${agent.name}` : ''}`;

  return (<>
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4" />
            {title}
          </DialogTitle>
        </DialogHeader>

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
              暂无群聊可绑定。请先在飞书/Telegram 群中向 Bot 发送消息，群聊会自动出现在此列表中。
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

              return (
                <div
                  key={group.jid}
                  className={`flex items-center gap-3 p-3 rounded-lg border ${
                    boundToThis
                      ? 'border-teal-500/30 bg-teal-50/50 dark:bg-teal-950/20'
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
                    <div className="text-sm font-medium truncate">{group.name}</div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{CHANNEL_LABEL[group.channel_type] || group.channel_type}</span>
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
                  </div>

                  {/* Action button — three states: unbind / rebind / bind */}
                  {boundToThis ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleUnbind(group.jid)}
                      disabled={isActioning}
                      className="flex-shrink-0"
                    >
                      {isActioning ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Unlink className="w-3 h-3 mr-1" />
                      )}
                      解绑
                    </Button>
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
