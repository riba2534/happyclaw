import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Pause,
  Play,
  Trash2,
  Zap,
} from 'lucide-react';
import { ScheduledTask } from '../../stores/tasks';
import { TaskDetail } from './TaskDetail';
import { showToast } from '../../utils/toast';
import { formatInterval } from '../../utils/task-utils';

interface TaskCardProps {
  task: ScheduledTask;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
  onRunNow?: (id: string) => void;
}

export function TaskCard({
  task,
  onPause,
  onResume,
  onDelete,
  onRunNow,
}: TaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  const navigate = useNavigate();

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active':
        return 'bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400';
      case 'parsing':
        return 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400';
      case 'paused':
        return 'bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400';
      case 'completed':
        return 'bg-muted text-muted-foreground';
      default:
        return 'bg-muted text-muted-foreground';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'active':
        return '运行中';
      case 'parsing':
        return 'AI 解析中...';
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
      showToast('任务已触发', '后台执行中，稍后刷新查看结果');
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
            {/* Title — derived from prompt first line, same as workspace name */}
            <p className="text-foreground font-semibold text-sm mb-1">
              {(task.prompt || '').split('\n')[0].trim().slice(0, 30).trim() ||
                task.id.slice(0, 8)}
            </p>

            {/* Badges */}
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
              {task.execution_type === 'script' && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300">
                  脚本
                </span>
              )}
              {task.execution_mode && (
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    task.execution_mode === 'host'
                      ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-300'
                      : 'bg-cyan-100 dark:bg-cyan-900/40 text-cyan-800 dark:text-cyan-300'
                  }`}
                >
                  {task.execution_mode === 'host' ? '宿主机' : 'Docker'}
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                {task.schedule_type === 'cron' && task.schedule_value}
                {task.schedule_type === 'interval' && `每 ${formatInterval(task.schedule_value)}`}
                {task.schedule_type === 'once' && '单次执行'}
              </span>
            </div>

            {/* Status Badge */}
            <div>
              <span
                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(
                  task.status,
                )}`}
              >
                {getStatusLabel(task.status)}
              </span>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Open Workspace */}
            {task.workspace_folder && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/chat/${task.workspace_folder}`);
                }}
                className="p-2 text-muted-foreground hover:text-primary hover:bg-brand-50 rounded-lg transition-colors cursor-pointer"
                title="打开工作区"
                aria-label="打开任务工作区"
              >
                <ExternalLink className="w-5 h-5" />
              </button>
            )}

            {/* Run Now */}
            {onRunNow &&
              (task.status === 'active' || task.status === 'paused') && (
                <button
                  onClick={handleRunNow}
                  disabled={runningNow}
                  className="p-2 text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
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
                className="p-2 text-muted-foreground hover:text-primary hover:bg-brand-50 rounded-lg transition-colors cursor-pointer"
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
              className="p-2 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg transition-colors cursor-pointer"
              title="删除"
              aria-label="删除任务"
            >
              <Trash2 className="w-5 h-5" />
            </button>

            {/* Expand Icon */}
            <div className="ml-2">
              {expanded ? (
                <ChevronUp className="w-5 h-5 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-5 h-5 text-muted-foreground" />
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
