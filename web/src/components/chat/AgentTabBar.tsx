import { Plus, X } from 'lucide-react';
import type { AgentInfo } from '../../types';

interface AgentTabBarProps {
  agents: AgentInfo[];
  activeTab: string | null; // null = main conversation
  onSelectTab: (agentId: string | null) => void;
  onDeleteAgent: (agentId: string) => void;
  onCreateConversation?: () => void;
}

const TASK_STATUS_ICON: Record<string, string> = {
  running: '\u{1F504}', // 🔄
  completed: '\u{2705}', // ✅
  error: '\u{274C}', // ❌
};

const tabClass = (active: boolean) =>
  `flex-shrink-0 px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
    active
      ? 'bg-teal-100 text-teal-800 shadow-sm'
      : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
  }`;

export function AgentTabBar({ agents, activeTab, onSelectTab, onDeleteAgent, onCreateConversation }: AgentTabBarProps) {
  const conversations = agents.filter(a => a.kind === 'conversation');
  const tasks = agents.filter(a => a.kind === 'task');

  // Show bar if there are agents OR if creation is available
  if (conversations.length === 0 && tasks.length === 0 && !onCreateConversation) return null;

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-slate-200 bg-slate-50/80 overflow-x-auto scrollbar-none">
      {/* Main conversation tab */}
      <button onClick={() => onSelectTab(null)} className={tabClass(activeTab === null)}>
        主对话
      </button>

      {/* Conversation tabs — same visual level as main */}
      {conversations.map((agent) => (
        <div
          key={agent.id}
          className={`${tabClass(activeTab === agent.id)} flex items-center gap-1.5 group`}
          onClick={() => onSelectTab(agent.id)}
        >
          {agent.status === 'running' && (
            <span className="w-1.5 h-1.5 rounded-full bg-teal-500 animate-pulse flex-shrink-0" />
          )}
          <span className="truncate max-w-[120px]">{agent.name}</span>
          <button
            onClick={(e) => { e.stopPropagation(); onDeleteAgent(agent.id); }}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-slate-200/80 transition-all cursor-pointer"
            title="关闭对话"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}

      {/* Create conversation button */}
      {onCreateConversation && (
        <button
          onClick={onCreateConversation}
          className="flex-shrink-0 flex items-center gap-0.5 px-2 py-1 rounded-md text-xs font-medium text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors cursor-pointer"
          title="新建对话"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Task agent tabs — subordinate style, separated */}
      {tasks.length > 0 && (
        <>
          <div className="w-px h-4 bg-slate-200 mx-1 flex-shrink-0" />
          {tasks.map((agent) => (
            <div
              key={agent.id}
              className={`flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer group ${
                activeTab === agent.id
                  ? 'bg-slate-200 text-slate-700 shadow-sm'
                  : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'
              }`}
              onClick={() => onSelectTab(agent.id)}
            >
              <span>{TASK_STATUS_ICON[agent.status] || ''}</span>
              <span className="truncate max-w-[100px]">{agent.name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteAgent(agent.id); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-slate-200 transition-all cursor-pointer"
                title="关闭"
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
