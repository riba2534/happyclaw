import { X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentInfo } from '../../types';

interface TopicSidebarProps {
  topicAgents: AgentInfo[];
  activeAgentTab: string | null;
  onSelectAgent: (id: string) => void;
  onDeleteAgent: (id: string) => void;
  topicFilter: string;
  onFilterChange: (value: string) => void;
  /** Total unfiltered count — used to distinguish "no topics" from "no matches" */
  emptyCount: number;
  /** Owner-only ACL (backend `can_modify`). Delete is owner-only server-side;
   *  hide the affordance for non-owners so it doesn't silently no-op. Defaults
   *  to false to match the read-only loading state. */
  canModify?: boolean;
}

export function TopicSidebar({
  topicAgents,
  activeAgentTab,
  onSelectAgent,
  onDeleteAgent,
  topicFilter,
  onFilterChange,
  emptyCount,
  canModify = false,
}: TopicSidebarProps) {
  return (
    <>
      <div className="border-b border-border px-4 py-3">
        <div className="text-sm font-semibold text-foreground">飞书话题</div>
        <div className="mt-1 text-xs text-muted-foreground">
          每个话题对应一个独立上下文
        </div>
        <input
          value={topicFilter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="搜索话题..."
          className="mt-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {topicAgents.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-background/70 px-4 py-8 text-center text-sm text-muted-foreground">
            {emptyCount === 0
              ? '等待飞书话题进入该工作区'
              : '没有匹配的话题'}
          </div>
        ) : (
          topicAgents.map((agent) => {
            const active = agent.id === activeAgentTab;
            return (
              <div
                key={agent.id}
                className={cn(
                  'group mb-0.5 flex items-center rounded-lg transition-colors',
                  active
                    ? 'bg-primary/10'
                    : 'hover:bg-muted/50',
                )}
              >
                <button
                  onClick={() => onSelectAgent(agent.id)}
                  className={cn(
                    'min-w-0 flex-1 px-3 py-2 text-left text-sm cursor-pointer flex items-center gap-1.5',
                    active
                      ? 'font-medium text-primary'
                      : 'text-foreground',
                  )}
                >
                  {agent.title_generating && (
                    <Loader2
                      className="h-3 w-3 shrink-0 animate-spin text-teal-500"
                      aria-label="正在生成标题"
                    />
                  )}
                  <span className="truncate">{agent.name}</span>
                </button>
                {canModify && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onDeleteAgent(agent.id); }}
                    className="mr-1 shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 cursor-pointer"
                    aria-label="删除话题会话"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
