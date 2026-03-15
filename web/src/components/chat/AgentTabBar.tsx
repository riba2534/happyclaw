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

const TASK_STATUS_ICON: Record<string, string> = {
  running: '\u{1F504}', // 🔄
  completed: '\u{2705}', // ✅
  error: '\u{274C}', // ❌
};

const tabClass = (active: boolean) =>
  `flex-shrink-0 px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
    active
      ? 'bg-accent text-accent-foreground shadow-sm'
      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
  }`;

export function AgentTabBar({ agents, activeTab, onSelectTab, onDeleteAgent, onCreateConversation, onBindIm, onBindMainIm }: AgentTabBarProps) {
  const conversations = agents.filter(a => a.kind === 'conversation');
  const tasks = agents.filter(a => a.kind === 'task');

  // Show bar if there are agents OR if creation is available
  if (conversations.length === 0 && tasks.length === 0 && !onCreateConversation) return null;

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 bg-background/80 overflow-x-auto scrollbar-none">
      {/* Main conversation tab */}
      <div
        className={`${tabClass(activeTab === null)} flex items-center gap-1.5 group`}
        onClick={() => onSelectTab(null)}
      >
        <span>主Agent</span>
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
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse flex-shrink-0" />
            )}
            {hasLinked && (
              <span title={`已绑定: ${agent.linked_im_groups!.map(g => g.name).join(', ')}`}>
                <MessageSquare className="w-3 h-3 text-blue-500 flex-shrink-0" />
              </span>
            )}
            <span className="truncate max-w-[80px]">{agent.name.length > 6 ? agent.name.slice(0, 6) : agent.name}</span>
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

      {/* Task agent tabs — subordinate style, separated */}
      {tasks.length > 0 && (
        <>
          <div className="w-px h-4 bg-border mx-1 flex-shrink-0" />
          {tasks.map((agent) => (
            <div
              key={agent.id}
              className={`flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer group ${
                activeTab === agent.id
                  ? 'bg-muted text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              }`}
              onClick={() => onSelectTab(agent.id)}
            >
              <span>{TASK_STATUS_ICON[agent.status] || ''}</span>
              <span className="truncate max-w-[80px]">{agent.name.length > 6 ? agent.name.slice(0, 6) : agent.name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteAgent(agent.id); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-border transition-all cursor-pointer"
                title="删除 Agent"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
