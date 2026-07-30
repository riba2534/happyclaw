import { useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Pause,
  Play,
  RotateCcw,
  Square,
  Trash2,
  Zap,
} from 'lucide-react';
import { ScheduledTask, type TaskRun } from '../../stores/tasks';
import { TaskDetail } from './TaskDetail';
import { showToast } from '../../utils/toast';
import {
  formatContextMode,
  formatInterval,
  formatTaskStatus,
} from '../../utils/task-utils';

interface TaskCardProps {
  task: ScheduledTask;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
  onRunNow?: (id: string) => void;
  onStopRun?: (runId: string | number) => void;
  onRestore?: (id: string) => void;
  onPurge?: (id: string) => void;
  isRunning?: boolean;
  isMutating?: boolean;
}

export function TaskCard({
  task,
  onPause,
  onResume,
  onDelete,
  onRunNow,
  onStopRun,
  onRestore,
  onPurge,
  isRunning = false,
  isMutating = false,
}: TaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  const navigate = useNavigate();
  const currentRun = task.current_run;
  const effectiveRunning =
    isRunning ||
    !!currentRun?.status.match(
      /^(queued|running|recovering|retry_wait|delivered)$/,
    );

  const runStatusLabel = (run: TaskRun): string => {
    switch (run.status) {
      case 'queued':
        return '排队中';
      case 'running':
        return '运行中';
      case 'recovering':
        return '正在恢复';
      case 'retry_wait':
        return `等待重试${run.attempt ? `（第 ${run.attempt + 1} 次）` : ''}`;
      case 'success':
        return '已成功';
      case 'failed':
      case 'error':
        return '已失败';
      case 'cancelled':
        return '已取消';
      case 'missed':
        return '已错过';
      case 'delivered':
        return '已投递到主会话';
    }
  };

  const getStatusColor = () => {
    if (task.deleted_at) {
      return 'bg-muted text-muted-foreground';
    }
    if (effectiveRunning) {
      return 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300';
    }
    switch (task.status) {
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

  const handleTogglePause = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (task.status === 'active') {
      onPause(task.id);
    } else {
      onResume(task.id);
    }
  };

  const handleRunNow = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!onRunNow || runningNow || effectiveRunning) return;
    setRunningNow(true);
    try {
      await onRunNow(task.id);
      showToast('任务已触发', '后台执行中，稍后刷新查看结果');
    } catch (err) {
      showToast('触发失败', err instanceof Error ? err.message : '请稍后重试');
    } finally {
      setRunningNow(false);
    }
  };

  const handleDelete = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (effectiveRunning) return;
    onDelete(task.id);
  };

  const toggleExpanded = () => setExpanded((v) => !v);

  const handleSummaryKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpanded();
    }
  };

  return (
    <article className="rounded-lg border border-border bg-card transition-colors duration-200 hover:border-primary/60">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        <button
          type="button"
          onClick={toggleExpanded}
          onKeyDown={handleSummaryKeyDown}
          aria-expanded={expanded}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <div className="min-w-0">
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
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {formatContextMode(task.context_mode)}
              </span>
              <span className="text-xs text-muted-foreground">
                {task.schedule_type === 'cron' && task.schedule_value}
                {task.schedule_type === 'interval' &&
                  `每 ${formatInterval(task.schedule_value)}`}
                {task.schedule_type === 'once' && '单次执行'}
              </span>
            </div>

            {/* Status Badge */}
            <div>
              <span
                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor()}`}
              >
                {task.deleted_at
                  ? '已移到回收站'
                  : currentRun
                    ? runStatusLabel(currentRun)
                    : formatTaskStatus(task.status, effectiveRunning)}
              </span>
              {task.deleted_at && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {new Date(task.deleted_at).toLocaleString('zh-CN')}
                </span>
              )}
              {task.permissions?.execution_blocked_reason && (
                <span className="ml-2 text-xs text-error">配置已阻止执行</span>
              )}
              {task.next_run && !task.deleted_at && (
                <span className="ml-2 text-xs text-muted-foreground">
                  下次：{new Date(task.next_run).toLocaleString('zh-CN')}
                </span>
              )}
              {['failed', 'partial_failed'].includes(
                task.last_run_summary?.notification_status || '',
              ) && <span className="ml-2 text-xs text-error">通知失败</span>}
            </div>
          </div>
        </button>

        <div className="flex shrink-0 items-center justify-end gap-1 sm:gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/chat/${task.group_folder}`);
            }}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-brand-50 hover:text-primary"
            title="打开所属工作区"
            aria-label="打开所属工作区"
          >
            <ExternalLink className="h-5 w-5" />
          </button>

          {onRunNow &&
            task.permissions?.can_run !== false &&
            !task.deleted_at &&
            (task.status === 'active' || task.status === 'paused') && (
              <button
                type="button"
                onClick={handleRunNow}
                disabled={runningNow || effectiveRunning}
                className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-amber-50 hover:text-amber-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-amber-950/40 dark:hover:text-amber-400"
                title={task.status === 'paused' ? '立即执行一次' : '立即运行'}
                aria-label={
                  task.status === 'paused'
                    ? '暂停状态立即执行一次'
                    : '立即运行任务'
                }
              >
                <Zap
                  className={`h-5 w-5 ${runningNow || effectiveRunning ? 'animate-pulse text-amber-500' : ''}`}
                />
              </button>
            )}

          {!task.deleted_at &&
            task.permissions?.can_pause !== false &&
            (task.status === 'active' || task.status === 'paused') && (
              <button
                type="button"
                onClick={handleTogglePause}
                className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-brand-50 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
                title={
                  task.status === 'active' ? '暂停后续计划' : '恢复后续计划'
                }
                aria-label={
                  task.status === 'active' ? '暂停后续计划' : '恢复后续计划'
                }
              >
                {task.status === 'active' ? (
                  <Pause className="h-5 w-5" />
                ) : (
                  <Play className="h-5 w-5" />
                )}
              </button>
            )}

          {currentRun &&
            onStopRun &&
            task.permissions?.can_stop !== false &&
            [
              'queued',
              'running',
              'recovering',
              'retry_wait',
              'delivered',
            ].includes(currentRun.status) && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onStopRun(currentRun.id);
                }}
                className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600"
                title="停止当前运行（不影响后续计划）"
                aria-label="停止当前运行"
              >
                <Square className="h-5 w-5" />
              </button>
            )}

          {task.deleted_at &&
            onRestore &&
            task.permissions?.can_restore !== false && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onRestore(task.id);
                }}
                disabled={isMutating}
                className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-brand-50 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                title="恢复为暂停状态"
                aria-label="恢复任务"
              >
                <RotateCcw className="h-5 w-5" />
              </button>
            )}

          {task.deleted_at &&
            onPurge &&
            task.permissions?.can_purge !== false && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onPurge(task.id);
                }}
                disabled={isMutating}
                className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                title="永久删除任务和运行历史"
                aria-label="永久删除任务"
              >
                <Trash2 className="h-5 w-5" />
              </button>
            )}

          {!task.deleted_at && task.permissions?.can_delete !== false && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={effectiveRunning || isMutating}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-red-950/40 dark:hover:text-red-400"
              title={
                effectiveRunning ? '请先停止当前运行' : '移到回收站并保留历史'
              }
              aria-label="将任务移到回收站"
            >
              <Trash2 className="h-5 w-5" />
            </button>
          )}

          <button
            type="button"
            onClick={toggleExpanded}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted"
            title={expanded ? '收起详情' : '展开详情'}
            aria-label={expanded ? '收起任务详情' : '展开任务详情'}
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronUp className="h-5 w-5" />
            ) : (
              <ChevronDown className="h-5 w-5" />
            )}
          </button>
        </div>
      </div>

      {/* Expanded Detail */}
      {expanded && (
        <div className="border-t border-border">
          <TaskDetail task={task} />
        </div>
      )}
    </article>
  );
}
