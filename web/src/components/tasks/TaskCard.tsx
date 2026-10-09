import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bot,
  ExternalLink,
  Eye,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Square,
  SquareTerminal,
  Trash2,
  Zap,
} from 'lucide-react';
import type { ScheduledTask, TaskRun } from '../../stores/tasks';
import { showToast } from '../../utils/toast';
import {
  formatContextMode,
  formatInterval,
  formatTaskStatus,
} from '../../utils/task-utils';
import { IconButton } from '@/components/common/IconButton';
import { ListRow } from '@/components/common/ListRow';
import { Badge, type BadgeDot } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

interface TaskCardProps {
  task: ScheduledTask;
  /** Display name of the owning workspace, shown in the row meta line. */
  workspaceName?: string;
  selected?: boolean;
  /** Open the detail sheet, optionally straight into edit mode. */
  onOpen?: (id: string, options?: { edit?: boolean }) => void;
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

function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function TaskCard({
  task,
  workspaceName,
  selected = false,
  onOpen,
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
  const [runningNow, setRunningNow] = useState(false);
  const navigate = useNavigate();
  const currentRun = task.current_run;
  const effectiveRunning =
    isRunning ||
    !!currentRun?.status.match(
      /^(queued|running|recovering|retry_wait|delivered)$/,
    );
  const isScript = task.execution_type === 'script';
  const title =
    (task.prompt || '').split('\n')[0].trim().slice(0, 80).trim() ||
    task.id.slice(0, 8);

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

  const getStatusDot = (): BadgeDot => {
    if (task.deleted_at) return 'muted';
    if (currentRun) {
      switch (currentRun.status) {
        case 'retry_wait':
        case 'missed':
          return 'warning';
        case 'failed':
        case 'error':
          return 'error';
        case 'success':
          return 'success';
        case 'cancelled':
          return 'muted';
        default:
          return 'primary';
      }
    }
    if (effectiveRunning) return 'primary';
    switch (task.status) {
      case 'active':
        return 'success';
      case 'parsing':
        return 'primary';
      case 'paused':
        return 'warning';
      default:
        return 'muted';
    }
  };

  const handleTogglePause = () => {
    if (task.status === 'active') {
      onPause(task.id);
    } else {
      onResume(task.id);
    }
  };

  const handleRunNow = async () => {
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

  const handleDelete = () => {
    if (effectiveRunning) return;
    onDelete(task.id);
  };

  const scheduleText =
    task.schedule_type === 'cron'
      ? task.schedule_value
      : task.schedule_type === 'interval'
        ? `每 ${formatInterval(task.schedule_value)}`
        : '单次执行';
  const notificationFailed = ['failed', 'partial_failed'].includes(
    task.last_run_summary?.notification_status || '',
  );
  const notificationUncertain =
    task.last_run_summary?.notification_status === 'uncertain';
  const timeMeta = task.deleted_at
    ? formatShortDate(task.deleted_at)
    : task.next_run
      ? `下次：${formatShortDate(task.next_run)}`
      : null;

  const canRun =
    onRunNow &&
    task.permissions?.can_run !== false &&
    !task.deleted_at &&
    (task.status === 'active' || task.status === 'paused');
  const canTogglePause =
    !task.deleted_at &&
    task.permissions?.can_pause !== false &&
    (task.status === 'active' || task.status === 'paused');
  const canStop =
    currentRun &&
    onStopRun &&
    task.permissions?.can_stop !== false &&
    ['queued', 'running', 'recovering', 'retry_wait', 'delivered'].includes(
      currentRun.status,
    );
  const canRestore =
    task.deleted_at && onRestore && task.permissions?.can_restore !== false;
  const canPurge =
    task.deleted_at && onPurge && task.permissions?.can_purge !== false;
  const canTrash = !task.deleted_at && task.permissions?.can_delete !== false;
  const canEdit = !task.deleted_at && task.permissions?.can_edit !== false;

  return (
    <ListRow
      selected={selected}
      onClick={onOpen ? () => onOpen(task.id) : undefined}
      className="gap-3 py-2.5"
      media={
        <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          {isScript ? (
            <SquareTerminal className="size-4" />
          ) : (
            <Bot className="size-4" />
          )}
        </span>
      }
      title={title}
      badges={
        <Badge
          variant="outline"
          dot={getStatusDot()}
          className={cn(effectiveRunning && 'text-foreground')}
        >
          {task.deleted_at
            ? '已移到回收站'
            : currentRun
              ? runStatusLabel(currentRun)
              : formatTaskStatus(task.status, effectiveRunning)}
        </Badge>
      }
      description={
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
          <span
            className={cn(task.schedule_type === 'cron' && 'font-mono')}
            title="调度"
          >
            {scheduleText}
          </span>
          {workspaceName && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{workspaceName}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span>{formatContextMode(task.context_mode)}</span>
          {isScript && (
            <>
              <span aria-hidden="true">·</span>
              <span>脚本</span>
            </>
          )}
          {task.execution_mode && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {task.execution_mode === 'host' ? '宿主机' : 'Docker'}
              </span>
            </>
          )}
          {timeMeta && (
            <span className="basis-full truncate sm:pointer-fine:hidden">
              {timeMeta}
            </span>
          )}
          {task.permissions?.execution_blocked_reason && (
            <span className="font-medium text-error">配置已阻止执行</span>
          )}
          {notificationFailed && (
            <span className="font-medium text-error">通知失败</span>
          )}
          {notificationUncertain && (
            <span className="font-medium text-warning">送达待确认</span>
          )}
        </span>
      }
      actions={
        <>
          {/* The time meta and the action cluster share one slot: pointer
              devices swap them on hover/focus, touch screens show actions. */}
          {timeMeta && (
            <span className="px-1 text-caption whitespace-nowrap text-muted-foreground tabular-nums max-sm:hidden pointer-coarse:hidden pointer-fine:group-focus-within/list-row:hidden pointer-fine:group-hover/list-row:hidden pointer-fine:group-has-[[aria-expanded=true]]/list-row:hidden">
              {timeMeta}
            </span>
          )}
          <div className="flex items-center gap-0.5 pointer-fine:hidden pointer-fine:group-focus-within/list-row:flex pointer-fine:group-hover/list-row:flex pointer-fine:group-has-[[aria-expanded=true]]/list-row:flex">
            {canStop && (
              <IconButton
                label="停止当前运行（不影响后续计划）"
                icon={<Square />}
                onClick={() => onStopRun!(currentRun!.id)}
                className="hover:text-error"
              />
            )}
            {canRun && (
              <IconButton
                label={task.status === 'paused' ? '立即执行一次' : '立即运行'}
                icon={
                  <Zap
                    className={cn(
                      (runningNow || effectiveRunning) &&
                        'animate-pulse text-warning',
                    )}
                  />
                }
                onClick={() => void handleRunNow()}
                disabled={runningNow || effectiveRunning}
                className="max-sm:hidden"
              />
            )}
            {canTogglePause && (
              <IconButton
                label={
                  task.status === 'active' ? '暂停后续计划' : '恢复后续计划'
                }
                icon={task.status === 'active' ? <Pause /> : <Play />}
                onClick={handleTogglePause}
                className="max-sm:hidden"
              />
            )}
            {canRestore && (
              <IconButton
                label="恢复为暂停状态"
                icon={<RotateCcw />}
                onClick={() => onRestore!(task.id)}
                disabled={isMutating}
                className="max-sm:hidden"
              />
            )}
            {canPurge && (
              <IconButton
                label="永久删除任务和运行历史"
                icon={<Trash2 />}
                onClick={() => onPurge!(task.id)}
                disabled={isMutating}
                className="hover:text-error max-sm:hidden"
              />
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  label={`${title}的更多操作`}
                  icon={<MoreHorizontal />}
                  hideTooltip
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {/* Phones only show the menu, so it repeats the row actions. */}
                {canRun && (
                  <DropdownMenuItem
                    className="sm:hidden"
                    onClick={() => void handleRunNow()}
                    disabled={runningNow || effectiveRunning}
                  >
                    <Zap />
                    {task.status === 'paused' ? '立即执行一次' : '立即运行'}
                  </DropdownMenuItem>
                )}
                {canTogglePause && (
                  <DropdownMenuItem
                    className="sm:hidden"
                    onClick={handleTogglePause}
                  >
                    {task.status === 'active' ? <Pause /> : <Play />}
                    {task.status === 'active' ? '暂停后续计划' : '恢复后续计划'}
                  </DropdownMenuItem>
                )}
                {canRestore && (
                  <DropdownMenuItem
                    className="sm:hidden"
                    onClick={() => onRestore!(task.id)}
                    disabled={isMutating}
                  >
                    <RotateCcw />
                    恢复为暂停状态
                  </DropdownMenuItem>
                )}
                {(canRun || canTogglePause || canRestore) && (
                  <DropdownMenuSeparator className="sm:hidden" />
                )}
                {onOpen && (
                  <DropdownMenuItem onClick={() => onOpen(task.id)}>
                    <Eye />
                    查看详情
                  </DropdownMenuItem>
                )}
                {onOpen && canEdit && (
                  <DropdownMenuItem
                    onClick={() => onOpen(task.id, { edit: true })}
                  >
                    <Pencil />
                    编辑
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => navigate(`/chat/${task.group_folder}`)}
                >
                  <ExternalLink />
                  打开所属工作区
                </DropdownMenuItem>
                {canPurge && (
                  <>
                    <DropdownMenuSeparator className="sm:hidden" />
                    <DropdownMenuItem
                      variant="destructive"
                      className="sm:hidden"
                      onClick={() => onPurge!(task.id)}
                      disabled={isMutating}
                    >
                      <Trash2 />
                      永久删除任务和运行历史
                    </DropdownMenuItem>
                  </>
                )}
                {canTrash && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={handleDelete}
                      disabled={effectiveRunning || isMutating}
                    >
                      <Trash2 />
                      {effectiveRunning ? '请先停止当前运行' : '移到回收站'}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      }
    />
  );
}
