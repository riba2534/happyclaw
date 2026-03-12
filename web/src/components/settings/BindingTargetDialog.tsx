import { useState, useMemo, useEffect } from 'react';
import { Loader2, FolderOpen, MessageSquare, RotateCcw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/common/SearchInput';
import type { BindingTarget } from './hooks/useImBindings';

interface BindingTargetDialogProps {
  open: boolean;
  imGroupName: string;
  targets: BindingTarget[];
  targetsLoading: boolean;
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
        (t.agentName && t.agentName.toLowerCase().includes(q)),
    );
  }, [targets, filter]);

  // Group targets by workspace
  const grouped = useMemo(() => {
    const map = new Map<string, BindingTarget[]>();
    for (const t of filtered) {
      const key = t.groupJid;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return map;
  }, [filtered]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { onClose(); setFilter(''); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base truncate">
            选择绑定目标 — {imGroupName}
          </DialogTitle>
        </DialogHeader>

        {!targetsLoading && targets.length > 3 && (
          <SearchInput
            value={filter}
            onChange={setFilter}
            placeholder="搜索工作区..."
            debounce={150}
          />
        )}

        <div className="space-y-3 max-h-80 overflow-y-auto">
          {targetsLoading && (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              加载中...
            </div>
          )}

          {!targetsLoading && targets.length === 0 && (
            <div className="text-center py-8 text-muted-foreground text-sm">
              暂无可绑定的工作区。请先创建一个非主页的工作区。
            </div>
          )}

          {!targetsLoading && targets.length > 0 && filtered.length === 0 && (
            <div className="text-center py-6 text-muted-foreground text-sm">
              没有匹配的目标
            </div>
          )}

          {!targetsLoading &&
            Array.from(grouped.entries()).map(([groupJid, items]) => (
              <div key={groupJid} className="space-y-1">
                <div className="flex items-center gap-1.5 px-1 text-xs font-medium text-slate-500">
                  <FolderOpen className="w-3 h-3" />
                  {items[0].groupName}
                </div>
                {items.map((target) => {
                  const key = target.agentId || `main:${target.groupJid}`;
                  const isSelecting = selecting === key;
                  return (
                    <button
                      key={key}
                      onClick={() => onSelect(target)}
                      disabled={!!selecting}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg border border-border hover:border-teal-300 hover:bg-teal-50/50 dark:hover:border-teal-700 dark:hover:bg-teal-950/20 transition-colors text-left cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <MessageSquare className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      <span className="flex-1 text-sm truncate">
                        {target.type === 'agent'
                          ? target.agentName || 'Agent'
                          : '主对话'}
                      </span>
                      {isSelecting && <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-500" />}
                    </button>
                  );
                })}
              </div>
            ))}
        </div>

        {/* Restore default button */}
        <div className="border-t border-border pt-3 mt-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onRestoreDefault}
            disabled={!!selecting}
            className="text-slate-500 hover:text-slate-700 w-full"
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            恢复默认路由
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
