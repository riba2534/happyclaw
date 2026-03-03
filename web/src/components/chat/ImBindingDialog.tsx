import { useState, useEffect, useMemo } from 'react';
import { Loader2, Link2, Unlink, MessageSquare, Users } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/common/SearchInput';
import { useChatStore } from '../../stores/chat';
import type { AgentInfo, AvailableImGroup } from '../../types';

interface ImBindingDialogProps {
  open: boolean;
  groupJid: string;
  agentId: string;
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

  const loadAvailableImGroups = useChatStore((s) => s.loadAvailableImGroups);
  const bindImGroup = useChatStore((s) => s.bindImGroup);
  const unbindImGroup = useChatStore((s) => s.unbindImGroup);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setFilter('');
    loadAvailableImGroups(groupJid).then((groups) => {
      setImGroups(groups);
      setLoading(false);
    });
  }, [open, groupJid, loadAvailableImGroups]);

  const filteredGroups = useMemo(() => {
    if (!filter.trim()) return imGroups;
    const q = filter.trim().toLowerCase();
    return imGroups.filter(
      (g) => g.name.toLowerCase().includes(q) || g.jid.toLowerCase().includes(q),
    );
  }, [imGroups, filter]);

  const handleBind = async (imJid: string) => {
    setActionLoading(imJid);
    const ok = await bindImGroup(groupJid, agentId, imJid);
    if (ok) {
      setImGroups((prev) =>
        prev.map((g) => (g.jid === imJid ? { ...g, bound_agent_id: agentId } : g)),
      );
    }
    setActionLoading(null);
  };

  const handleUnbind = async (imJid: string) => {
    setActionLoading(imJid);
    const ok = await unbindImGroup(groupJid, agentId, imJid);
    if (ok) {
      setImGroups((prev) =>
        prev.map((g) => (g.jid === imJid ? { ...g, bound_agent_id: null } : g)),
      );
    }
    setActionLoading(null);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4" />
            绑定 IM 群组{agent ? ` — ${agent.name}` : ''}
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
              const isBoundToThis = group.bound_agent_id === agentId;
              const isBoundToOther = !!group.bound_agent_id && !isBoundToThis;
              const isActioning = actionLoading === group.jid;

              return (
                <div
                  key={group.jid}
                  className={`flex items-center gap-3 p-3 rounded-lg border ${
                    isBoundToThis
                      ? 'border-teal-500/30 bg-teal-50/50 dark:bg-teal-950/20'
                      : isBoundToOther
                        ? 'border-border opacity-50'
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
                      {isBoundToOther && <span className="text-amber-500">已绑定到其他对话</span>}
                    </div>
                  </div>

                  {/* Action button */}
                  {isBoundToThis ? (
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
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => handleBind(group.jid)}
                      disabled={isActioning || isBoundToOther}
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
  );
}
