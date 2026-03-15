import { Plus, X, Link, MessageSquare, Info, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import type { AgentInfo } from '../../types';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface AgentTabBarProps {
  agents: AgentInfo[];
  activeTab: string | null; // null = main conversation
  onSelectTab: (agentId: string | null) => void;
  onDeleteAgent: (agentId: string) => void;
  onCreateConversation?: () => void;
  onBindIm?: (agentId: string) => void;
  /** Show bind button on main conversation tab (non-home workspaces) */
  onBindMainIm?: () => void;
}

function TaskStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'running':
      return <Loader2 className="w-3.5 h-3.5 text-primary animate-spin flex-shrink-0" />;
    case 'completed':
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />;
    case 'error':
      return <XCircle className="w-3.5 h-3.5 text-destructive flex-shrink-0" />;
    default:
      return null;
  }
}

export function AgentTabBar({ agents, activeTab, onSelectTab, onDeleteAgent, onCreateConversation, onBindIm, onBindMainIm }: AgentTabBarProps) {
  const conversations = agents.filter(a => a.kind === 'conversation');
  const tasks = agents.filter(a => a.kind === 'task');

  // Show bar if there are agents OR if creation is available
  if (conversations.length === 0 && tasks.length === 0 && !onCreateConversation) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center gap-1 px-3 py-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] bg-card/80 backdrop-blur-sm overflow-x-auto scrollbar-none">
        {/* Main Agent tab */}
        <div
          className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer group ${
            activeTab === null
              ? 'bg-primary/10 text-primary font-semibold'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
          onClick={() => onSelectTab(null)}
        >
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${activeTab === null ? 'bg-primary' : 'bg-muted-foreground/40'}`} />
          <span>主 Agent</span>
          {onBindMainIm && (
            <button
              onClick={(e) => { e.stopPropagation(); onBindMainIm(); }}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-primary/10 transition-all cursor-pointer"
              title="绑定 IM 群组"
            >
              <Link className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Info tooltip */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="flex-shrink-0 p-1 rounded-md text-muted-foreground/40 hover:text-muted-foreground transition-colors cursor-pointer">
              <Info className="w-3.5 h-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[240px]">
            HappyClaw 会根据任务复杂度自主生成和调度 Agent，无需任何手动操作
          </TooltipContent>
        </Tooltip>

        {/* Conversation tabs — same visual level as main */}
        {conversations.map((agent) => {
          const hasLinked = agent.linked_im_groups && agent.linked_im_groups.length > 0;
          return (
            <div
              key={agent.id}
              className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer group ${
                activeTab === agent.id
                  ? 'bg-primary/10 text-primary font-semibold'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
              onClick={() => onSelectTab(agent.id)}
            >
              {agent.status === 'running' && (
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse flex-shrink-0" />
              )}
              {hasLinked && (
                <span title={`已绑定: ${agent.linked_im_groups!.map(g => g.name).join(', ')}`}>
                  <MessageSquare className="w-3 h-3 text-primary flex-shrink-0" />
                </span>
              )}
              <span className="truncate max-w-[120px]">{agent.name}</span>
              {onBindIm && (
                <button
                  onClick={(e) => { e.stopPropagation(); onBindIm(agent.id); }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-primary/10 transition-all cursor-pointer"
                  title="绑定 IM 群组"
                >
                  <Link className="w-3 h-3" />
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteAgent(agent.id); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-primary/10 transition-all cursor-pointer"
                title="关闭对话"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}

        {/* Create conversation button */}
        {onCreateConversation && (
          <button
            onClick={onCreateConversation}
            className="flex-shrink-0 flex items-center gap-0.5 px-2 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
            title="新建对话"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Task agent tabs — subordinate style, separated */}
        {tasks.length > 0 && (
          <>
            <div className="w-px h-5 bg-border/60 mx-1 flex-shrink-0" />
            {tasks.map((agent) => (
              <div
                key={agent.id}
                className={`flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer group ${
                  activeTab === agent.id
                    ? 'bg-muted text-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                }${agent.status === 'running' ? ' border-l-2 border-l-primary' : ''}`}
                onClick={() => onSelectTab(agent.id)}
              >
                <TaskStatusIcon status={agent.status} />
                <span className="truncate max-w-[100px]">{agent.name}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onDeleteAgent(agent.id); }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted transition-all cursor-pointer"
                  title="删除 Agent"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </>
        )}
      </div>
    </TooltipProvider>
  );
}
