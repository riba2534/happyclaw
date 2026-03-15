import { useChatStore } from '../../stores/chat';
import type { AgentInfo } from '../../types';

interface AgentStatusCardProps {
  agent: AgentInfo;
  onClick?: () => void;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  running: { bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500 animate-pulse' },
  completed: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  error: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500' },
};

const STATUS_LABELS: Record<string, string> = {
  running: '执行中',
  completed: '已完成',
  error: '出错',
};

export function AgentStatusCard({ agent, onClick }: AgentStatusCardProps) {
  const colors = STATUS_COLORS[agent.status] || STATUS_COLORS.running;
  const streaming = useChatStore((s) => s.agentStreaming[agent.id]);
  const isRunning = agent.status === 'running';

  return (
    <div
      onClick={onClick}
      className={`${colors.bg} border border-current/10 rounded-lg p-3 my-2 cursor-pointer hover:bg-muted/50 transition-colors`}
    >
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${colors.dot}`} />
        <span className={`text-sm font-medium ${colors.text}`}>
          子 Agent: {agent.name}
        </span>
        <span className={`text-xs ${colors.text} opacity-70`}>
          {STATUS_LABELS[agent.status]}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
        {agent.prompt}
      </p>
      {isRunning && streaming && (
        <div className="mt-1.5 border-t border-current/5 pt-1.5 space-y-1">
          {streaming.isThinking && (
            <p className="text-xs text-blue-500 italic">思考中...</p>
          )}
          {streaming.activeTools.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {streaming.activeTools.map((t) => (
                <span
                  key={t.toolUseId}
                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700"
                >
                  {t.toolName}
                </span>
              ))}
            </div>
          )}
          {streaming.partialText && (
            <p className="text-xs text-muted-foreground truncate">
              {streaming.partialText.slice(0, 100)}
            </p>
          )}
        </div>
      )}
      {agent.result_summary && !isRunning && (
        <p className="mt-1.5 text-xs text-muted-foreground line-clamp-3 border-t border-current/5 pt-1.5">
          {agent.result_summary}
        </p>
      )}
    </div>
  );
}
