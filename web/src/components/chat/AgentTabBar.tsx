import { Plus, X, Link, MessageSquare } from 'lucide-react';
import type { AgentInfo } from '../../types';

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

const tabClass = (active: boolean) =>
  `flex-shrink-0 px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
    active
      ? 'bg-accent text-accent-foreground shadow-sm'
      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
  }`;

export function AgentTabBar({ agents, activeTab, onSelectTab, onDeleteAgent, onCreateConversation, onBindIm, onBindMainIm }: AgentTabBarProps) {
  const conversations = agents.filter(a => a.kind === 'conversation');

  // Show bar if there are agents OR if creation is available
  if (conversations.length === 0 && !onCreateConversation) return null;

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border bg-background/80 overflow-x-auto scrollbar-none">
      {/* Main conversation tab */}
      <div
        className={`${tabClass(activeTab === null)} flex items-center gap-1.5 group`}
        onClick={() => onSelectTab(null)}
      >
        <span>主对话</span>
        {onBindMainIm && (
          <button
            onClick={(e) => { e.stopPropagation(); onBindMainIm(); }}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent transition-all cursor-pointer"
            title="绑定 IM 群组"
          >
            <Link className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Conversation tabs — same visual level as main */}
      {conversations.map((agent) => {
        const hasLinked = agent.linked_im_groups && agent.linked_im_groups.length > 0;
        return (
          <div
            key={agent.id}
            className={`${tabClass(activeTab === agent.id)} flex items-center gap-1.5 group`}
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
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent transition-all cursor-pointer"
                title="绑定 IM 群组"
              >
                <Link className="w-3 h-3" />
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onDeleteAgent(agent.id); }}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent transition-all cursor-pointer"
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
          className="flex-shrink-0 flex items-center gap-0.5 px-2 py-1 rounded-md text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
          title="新建对话"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      )}

    </div>
  );
}
