import { useState } from 'react';
import { ChevronDown, ChevronUp, Pause, Play, Trash2, Zap } from 'lucide-react';
import { ScheduledTask } from '../../stores/tasks';
import { TaskDetail } from './TaskDetail';

interface TaskCardProps {
  task: ScheduledTask;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
  onRunNow?: (id: string) => void;
}

export function TaskCard({ task, onPause, onResume, onDelete, onRunNow }: TaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [runningNow, setRunningNow] = useState(false);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active':
        return 'bg-green-100 text-green-600';
      case 'paused':
        return 'bg-amber-100 text-amber-600';
      case 'completed':
        return 'bg-slate-100 text-slate-500';
      default:
        return 'bg-slate-100 text-slate-600';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'active':
        return '运行中';
      case 'paused':
        return '已暂停';
      case 'completed':
        return '已完成';
      default:
        return status;
    }
  };

  const handleTogglePause = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (task.status === 'active') {
      onPause(task.id);
    } else {
      onResume(task.id);
    }
  };

  const handleRunNow = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onRunNow || runningNow) return;
    setRunningNow(true);
    try {
      await onRunNow(task.id);
    } finally {
      setTimeout(() => setRunningNow(false), 3000);
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(task.id);
  };

  return (
    <div className="bg-card rounded-xl border border-border hover:border-brand-300 transition-colors duration-200">
      {/* Card Header - Clickable */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 text-left cursor-pointer"
      >
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0 mr-4">
            {/* Prompt / Script (truncated 2 lines) */}
            <p className="text-foreground font-medium line-clamp-2 mb-2">
              {task.execution_type === 'script'
                ? task.script_command || task.prompt
                : task.prompt}
            </p>

            {/* Schedule Info */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm mb-2">
              {task.execution_type === 'script' && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                  脚本
                </span>
              )}
              <div className="flex items-center gap-2">
                <span className="text-slate-500">调度:</span>
                <span className="text-foreground font-medium">
                  {task.schedule_type === 'cron' && 'Cron'}
                  {task.schedule_type === 'interval' && '间隔'}
                  {task.schedule_type === 'once' && '单次'}
                </span>
                <code className="text-xs bg-muted px-2 py-0.5 rounded">
                  {task.schedule_value}
                </code>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-slate-500">群组:</span>
                <span className="text-foreground font-medium">
                  {task.group_folder}
                </span>
              </div>
            </div>

            {/* Status Badge */}
            <div>
              <span
                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(
                  task.status
                )}`}
              >
                {getStatusLabel(task.status)}
              </span>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Run Now */}
            {onRunNow &&
              (task.status === 'active' || task.status === 'paused') && (
                <button
                  onClick={handleRunNow}
                  disabled={runningNow}
                  className="p-2 text-slate-600 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                  title="立即运行"
                  aria-label="立即运行任务"
                >
                  <Zap
                    className={`w-5 h-5 ${runningNow ? 'animate-pulse text-amber-500' : ''}`}
                  />
                </button>
              )}

            {/* Pause/Resume */}
            {(task.status === 'active' || task.status === 'paused') && (
              <button
                onClick={handleTogglePause}
                className="p-2 text-slate-600 hover:text-primary hover:bg-brand-50 rounded-lg transition-colors cursor-pointer"
                title={task.status === 'active' ? '暂停' : '恢复'}
                aria-label={task.status === 'active' ? '暂停任务' : '恢复任务'}
              >
                {task.status === 'active' ? (
                  <Pause className="w-5 h-5" />
                ) : (
                  <Play className="w-5 h-5" />
                )}
              </button>
            )}

            {/* Delete */}
            <button
              onClick={handleDelete}
              className="p-2 text-slate-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
              title="删除"
              aria-label="删除任务"
            >
              <Trash2 className="w-5 h-5" />
            </button>

            {/* Expand Icon */}
            <div className="ml-2">
              {expanded ? (
                <ChevronUp className="w-5 h-5 text-slate-400" />
              ) : (
                <ChevronDown className="w-5 h-5 text-slate-400" />
              )}
            </div>
          </div>
        </div>
      </button>

      {/* Expanded Detail */}
      {expanded && (
        <div className="border-t border-border">
          <TaskDetail task={task} />
        </div>
      )}
    </div>
  );
}
