import { useState, useMemo, useEffect } from 'react';
import {
  Bot,
  Loader2,
  FolderOpen,
  MessageSquare,
  RotateCcw,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/common/SearchInput';
import type { BindingTarget } from './hooks/useImBindings';
import { getAgentProfileDisplayName } from '../../utils/agent-product';

interface BindingTargetDialogProps {
  open: boolean;
  imGroupName: string;
  targets: BindingTarget[];
  targetsLoading: boolean;
  targetType: 'workspace' | 'session' | 'both';
  canUnbind: boolean;
  onSelect: (target: BindingTarget) => void;
  onRestoreDefault: () => void;
  onClose: () => void;
  selecting?: string | null;
}

export function BindingTargetDialog({
  open,
  imGroupName,
  targets,
  targetsLoading,
  targetType,
  canUnbind,
  onSelect,
  onRestoreDefault,
  onClose,
  selecting,
}: BindingTargetDialogProps) {
  const [filter, setFilter] = useState('');

  // Clear filter when dialog closes to avoid stale search state on reopen
  useEffect(() => {
    if (!open) setFilter('');
  }, [open]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return targets;
    const q = filter.trim().toLowerCase();
    return targets.filter(
      (t) =>
        t.groupName.toLowerCase().includes(q) ||
        (t.sessionName && t.sessionName.toLowerCase().includes(q)),
    );
  }, [targets, filter]);

  // Group targets by Agent profile, then workspace.
  const grouped = useMemo(() => {
    const map = new Map<
      string,
      {
        agentName: string;
        workspaces: Map<string, BindingTarget[]>;
      }
    >();
    for (const t of filtered) {
      const agentKey = t.agentProfileId || t.agentProfileName || 'default';
      if (!map.has(agentKey)) {
        map.set(agentKey, {
          agentName: getAgentProfileDisplayName(t.agentProfileName),
          workspaces: new Map(),
        });
      }
      const agentGroup = map.get(agentKey)!;
      if (!agentGroup.workspaces.has(t.groupJid)) {
        agentGroup.workspaces.set(t.groupJid, []);
      }
      agentGroup.workspaces.get(t.groupJid)!.push(t);
    }
    return map;
  }, [filtered]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          onClose();
          setFilter('');
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">
            {targetType === 'workspace'
              ? '选择工作区'
              : targetType === 'session'
                ? '选择会话'
                : '选择工作区或会话'}{' '}
            — {imGroupName}
          </DialogTitle>
        </DialogHeader>

        {!targetsLoading && targets.length > 3 && (
          <SearchInput
            value={filter}
            onChange={setFilter}
            placeholder={
              targetType === 'workspace'
                ? '搜索工作区...'
                : targetType === 'session'
                  ? '搜索会话...'
                  : '搜索工作区或会话...'
            }
            debounce={150}
          />
        )}

        <div className="-mx-1 max-h-80 space-y-4 overflow-y-auto px-1">
          {targetsLoading && (
            <div className="flex items-center justify-center py-8 text-body text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              加载中...
            </div>
          )}

          {!targetsLoading && targets.length === 0 && (
            <div className="py-8 text-center text-caption text-muted-foreground">
              {targetType === 'workspace'
                ? '暂无可绑定的工作区。请先创建工作区。'
                : targetType === 'session'
                  ? '暂无可绑定的会话。请先在工作区内创建会话。'
                  : '暂无可绑定的工作区或会话。'}
            </div>
          )}

          {!targetsLoading && targets.length > 0 && filtered.length === 0 && (
            <div className="py-6 text-center text-caption text-muted-foreground">
              没有匹配的目标
            </div>
          )}

          {!targetsLoading &&
            Array.from(grouped.entries()).map(([agentKey, agentGroup]) => (
              <div key={agentKey} className="space-y-1.5">
                <div className="flex items-center gap-1.5 px-1 text-caption font-medium text-foreground">
                  <Bot className="size-3.5 text-muted-foreground" />
                  {agentGroup.agentName}
                </div>
                {Array.from(agentGroup.workspaces.entries()).map(
                  ([groupJid, items]) => (
                    <div
                      key={groupJid}
                      className="overflow-hidden rounded-lg ring-1 ring-surface-border"
                    >
                      <div className="flex items-center gap-1.5 border-b border-surface-border bg-muted/40 px-3 py-1.5 text-caption text-muted-foreground">
                        <FolderOpen className="size-3.5" />
                        <span className="truncate">{items[0].groupName}</span>
                      </div>
                      <div className="space-y-0.5 p-1">
                        {items.map((target) => {
                          const key = `${target.groupJid}:${target.type}:${target.sessionId ?? ''}`;
                          const isSelecting = selecting === key;
                          return (
                            <Button
                              key={key}
                              type="button"
                              variant="ghost"
                              onClick={() => onSelect(target)}
                              disabled={!!selecting}
                              className="h-8 w-full justify-start gap-2.5 px-2 font-normal pointer-coarse:min-h-11"
                            >
                              <MessageSquare className="size-4 text-muted-foreground" />
                              <span className="min-w-0 flex-1 truncate text-left text-body">
                                {target.type === 'session'
                                  ? target.sessionName || '会话'
                                  : '绑定到此工作区'}
                              </span>
                              {isSelecting && (
                                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                              )}
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  ),
                )}
              </div>
            ))}
        </div>

        {canUnbind && (
          <DialogFooter className="sm:justify-start">
            <Button
              variant="ghost"
              size="sm"
              onClick={onRestoreDefault}
              disabled={!!selecting}
              className="text-muted-foreground"
            >
              <RotateCcw className="size-3.5" />
              解除渠道绑定
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
