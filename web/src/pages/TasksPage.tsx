import { useEffect, useState } from 'react';
import { Clock, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { TaskCard } from '../components/tasks/TaskCard';
import { CreateTaskForm } from '../components/tasks/CreateTaskForm';
import { useTasksStore, type ScheduledTask } from '../stores/tasks';
import { useAuthStore } from '../stores/auth';
import { useGroupsStore } from '../stores/groups';
import { showToast } from '../utils/toast';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

type TaskView = 'current' | 'trash';
type PendingTaskAction =
  | { kind: 'trash'; ids: [string] }
  | { kind: 'purge'; ids: string[] };

function taskTitle(task: ScheduledTask): string {
  return (
    (task.prompt || '').split('\n')[0].trim().slice(0, 80).trim() ||
    task.id.slice(0, 8)
  );
}

export function TasksPage() {
  const {
    tasks,
    loading,
    error,
    runningTaskIds,
    groupNames,
    loadTasks,
    createTask,
    updateTaskStatus,
    deleteTask,
    restoreTask,
    purgeTasks,
    runTaskNow,
    stopTaskRun,
  } = useTasksStore();
  const { user } = useAuthStore();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [view, setView] = useState<TaskView>('current');
  const [query, setQuery] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingTaskAction | null>(
    null,
  );
  const [actionLoading, setActionLoading] = useState(false);
  const [mutatingTaskIds, setMutatingTaskIds] = useState<Set<string>>(
    new Set(),
  );
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // Poll while any task is parsing/running so UI updates when done.
  const hasParsing = tasks.some((task) => task.status === 'parsing');
  const liveRunStatuses = new Set([
    'queued',
    'running',
    'recovering',
    'retry_wait',
  ]);
  const hasRunning =
    runningTaskIds.size > 0 ||
    tasks.some(
      (task) =>
        task.current_run && liveRunStatuses.has(task.current_run.status),
    );
  const hasNotificationWork = tasks.some(
    (task) =>
      task.last_run_summary?.notification_status === 'pending' ||
      !!task.last_run_summary?.notification_available_at,
  );
  const liveRunCount = new Set([
    ...runningTaskIds,
    ...tasks
      .filter(
        (task) =>
          task.current_run && liveRunStatuses.has(task.current_run.status),
      )
      .map((task) => task.id),
  ]).size;
  useEffect(() => {
    if (!hasParsing && !hasRunning && !hasNotificationWork) return;
    const interval = setInterval(loadTasks, 3000);
    return () => clearInterval(interval);
  }, [hasParsing, hasRunning, hasNotificationWork, loadTasks]);

  const handleCreateTask = async (data: {
    prompt: string;
    scheduleType: 'cron' | 'interval' | 'once';
    scheduleValue: string;
    executionType: 'agent' | 'script';
    executionMode?: 'host' | 'container';
    scriptCommand: string;
    notifyChannels: string[] | null;
    chatJid?: string;
    contextMode?: 'group' | 'isolated';
    budget?: import('../types').TaskBudgetConfig | null;
  }) => {
    await createTask(
      data.prompt,
      data.scheduleType,
      data.scheduleValue,
      data.executionType,
      data.executionMode,
      data.scriptCommand,
      data.notifyChannels,
      data.chatJid,
      data.contextMode,
      data.budget,
    );
    if (!useTasksStore.getState().error) {
      setShowCreateForm(false);
      setView('current');
    }
  };

  const handlePause = async (id: string) => {
    if (
      confirm(
        '暂停后续计划？\n\n当前正在运行的任务会继续执行。如需终止，请使用“停止当前运行”。',
      )
    ) {
      await updateTaskStatus(id, 'paused');
    }
  };

  const handleResume = async (id: string) => {
    const task = tasks.find((candidate) => candidate.id === id);
    const message =
      task?.schedule_type === 'once'
        ? `启用这个一次性任务？\n\n任务会在 ${new Date(task.schedule_value).toLocaleString('zh-CN')} 执行；如果该时间已过，请先修改为未来时间。`
        : '确定要恢复此任务吗？';
    if (confirm(message)) {
      await updateTaskStatus(id, 'active');
    }
  };

  const handleDelete = (id: string) => {
    setPendingAction({ kind: 'trash', ids: [id] });
  };

  const handlePurge = (id: string) => {
    setPendingAction({ kind: 'purge', ids: [id] });
  };

  const handleStopRun = async (runId: string | number) => {
    if (
      confirm(
        '停止当前运行？\n\n本次运行会被取消，后续计划不受影响。已经完成的外部操作无法撤销。',
      )
    ) {
      await stopTaskRun(runId);
    }
  };

  const handleRestore = async (id: string) => {
    if (
      !confirm(
        '恢复这个任务？\n\n任务会恢复为暂停状态，不会立即触发。一次性任务若已过原定时间，需要先修改为未来时间再启用。',
      )
    ) {
      return;
    }
    setMutatingTaskIds((current) => new Set(current).add(id));
    try {
      await restoreTask(id);
      showToast('任务已恢复', '任务处于暂停状态，可检查配置后重新启用。');
    } catch {
      // The store exposes the actionable API message in the page-level alert.
    } finally {
      setMutatingTaskIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const executePendingAction = async () => {
    if (!pendingAction || actionLoading) return;
    setActionLoading(true);
    setMutatingTaskIds((current) => {
      const next = new Set(current);
      pendingAction.ids.forEach((id) => next.add(id));
      return next;
    });
    try {
      if (pendingAction.kind === 'trash') {
        await deleteTask(pendingAction.ids[0]);
        useGroupsStore.getState().loadGroups();
        showToast(
          '任务已移到回收站',
          '任务不会再触发，运行历史仍可查看和恢复。',
        );
      } else {
        const count = await purgeTasks(pendingAction.ids);
        showToast(
          count === 1 ? '任务已永久删除' : `已永久删除 ${count} 个任务`,
          '任务定义和运行历史已清除，无法恢复。',
        );
      }
      setPendingAction(null);
    } catch {
      // Keep the dialog open so the user can read the page-level error and retry.
    } finally {
      setActionLoading(false);
      setMutatingTaskIds((current) => {
        const next = new Set(current);
        pendingAction.ids.forEach((id) => next.delete(id));
        return next;
      });
    }
  };

  const deletedTasks = tasks.filter((task) => !!task.deleted_at);
  const liveTasks = tasks.filter((task) => !task.deleted_at);
  const enabledTasks = liveTasks.filter((task) => task.status === 'active');
  const pausedTasks = liveTasks.filter((task) => task.status === 'paused');
  const retryingCount = liveTasks.filter(
    (task) => task.current_run?.status === 'retry_wait',
  ).length;
  const purgeableDeletedTasks = deletedTasks.filter(
    (task) => task.permissions?.can_purge !== false,
  );

  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const matchesQuery = (task: ScheduledTask) => {
    if (!normalizedQuery) return true;
    return [
      task.prompt,
      task.id,
      task.group_folder,
      task.chat_jid,
      groupNames[task.chat_jid],
    ]
      .filter(Boolean)
      .some((value) =>
        String(value).toLocaleLowerCase('zh-CN').includes(normalizedQuery),
      );
  };
  const filteredLiveTasks = liveTasks.filter(matchesQuery);
  const filteredDeletedTasks = deletedTasks.filter(matchesQuery);
  const currentSections = [
    {
      key: 'active',
      title: '已启用',
      tasks: filteredLiveTasks.filter((task) => task.status === 'active'),
    },
    {
      key: 'paused',
      title: '已暂停',
      tasks: filteredLiveTasks.filter((task) => task.status === 'paused'),
    },
    {
      key: 'other',
      title: '其他',
      tasks: filteredLiveTasks.filter(
        (task) => task.status !== 'active' && task.status !== 'paused',
      ),
    },
  ];

  const pendingTask =
    pendingAction?.ids.length === 1
      ? tasks.find((task) => task.id === pendingAction.ids[0])
      : undefined;
  const pendingIsPurge = pendingAction?.kind === 'purge';
  const pendingCount = pendingAction?.ids.length ?? 0;

  const renderCurrentTasks = () => {
    if (filteredLiveTasks.length === 0) {
      if (normalizedQuery) {
        return (
          <EmptyState
            icon={Search}
            title="没有匹配的当前任务"
            description="可以搜索任务名称、工作区名称或任务 ID。"
            action={
              <Button variant="outline" onClick={() => setQuery('')}>
                清除搜索
              </Button>
            }
          />
        );
      }
      return (
        <EmptyState
          icon={Clock}
          title="当前没有定时任务"
          description={
            deletedTasks.length > 0
              ? `有 ${deletedTasks.length} 个任务在回收站，不会再触发。`
              : '定时任务会在所属工作区内自动执行，默认使用独立任务会话。'
          }
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => setShowCreateForm(true)}>
                <Plus />
                创建任务
              </Button>
              {deletedTasks.length > 0 && (
                <Button variant="outline" onClick={() => setView('trash')}>
                  查看回收站
                </Button>
              )}
            </div>
          }
        />
      );
    }

    return (
      <div className="space-y-7">
        {currentSections.map(
          (section) =>
            section.tasks.length > 0 && (
              <section
                key={section.key}
                aria-labelledby={`${section.key}-tasks`}
              >
                <h2
                  id={`${section.key}-tasks`}
                  className="mb-3 text-sm font-semibold text-foreground"
                >
                  {section.title}
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    {section.tasks.length}
                  </span>
                </h2>
                <div className="space-y-3">
                  {section.tasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      isRunning={runningTaskIds.has(task.id)}
                      isMutating={mutatingTaskIds.has(task.id)}
                      onPause={handlePause}
                      onResume={handleResume}
                      onDelete={handleDelete}
                      onRunNow={runTaskNow}
                      onStopRun={handleStopRun}
                    />
                  ))}
                </div>
              </section>
            ),
        )}
      </div>
    );
  };

  const renderTrash = () => {
    if (filteredDeletedTasks.length === 0) {
      return (
        <EmptyState
          icon={Trash2}
          title={normalizedQuery ? '没有匹配的回收站任务' : '回收站是空的'}
          description={
            normalizedQuery
              ? '清除搜索条件，查看回收站中的其他任务。'
              : '移到回收站的任务会保留运行历史，可以恢复或永久删除。'
          }
          action={
            normalizedQuery ? (
              <Button variant="outline" onClick={() => setQuery('')}>
                清除搜索
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setView('current')}>
                返回当前任务
              </Button>
            )
          }
        />
      );
    }

    return (
      <section aria-labelledby="trashed-tasks">
        <h2 id="trashed-tasks" className="sr-only">
          回收站任务
        </h2>
        <div className="space-y-3">
          {filteredDeletedTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              isRunning={false}
              isMutating={mutatingTaskIds.has(task.id)}
              onPause={handlePause}
              onResume={handleResume}
              onDelete={handleDelete}
              onRestore={handleRestore}
              onPurge={handlePurge}
              onStopRun={handleStopRun}
            />
          ))}
        </div>
      </section>
    );
  };

  return (
    <div className="min-h-full bg-background">
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <PageHeader
          title="定时任务管理"
          subtitle={`当前 ${liveTasks.length} · ${enabledTasks.length} 已启用 · ${pausedTasks.length} 已暂停 · ${liveRunCount} 执行中${retryingCount > 0 ? ` · ${retryingCount} 等待重试` : ''} · 回收站 ${deletedTasks.length}`}
          className="mb-5 flex-col !items-stretch [&>div:first-child]:w-full [&>div:last-child]:justify-end sm:flex-row sm:!items-center sm:[&>div:first-child]:w-auto"
          actions={
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <Button variant="outline" onClick={loadTasks} disabled={loading}>
                <RefreshCw className={loading ? 'animate-spin' : ''} />
                刷新
              </Button>
              <Button onClick={() => setShowCreateForm(true)}>
                <Plus />
                创建任务
              </Button>
            </div>
          }
        />

        {error && (
          <div
            role="alert"
            className="mb-4 flex items-center justify-between rounded-lg border border-error/20 bg-error-bg p-3"
          >
            <span className="text-sm text-error">{error}</span>
            <button
              type="button"
              onClick={() => useTasksStore.setState({ error: null })}
              className="rounded p-1 text-error transition-colors hover:bg-error/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/40"
              aria-label="关闭错误提示"
            >
              <X size={16} />
            </button>
          </div>
        )}

        <div className="mb-5 flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between">
          <Tabs
            value={view}
            onValueChange={(value) => setView(value as TaskView)}
            className="block"
          >
            <TabsList aria-label="任务视图">
              <TabsTrigger value="current">
                当前任务
                <span className="text-xs text-muted-foreground">
                  {liveTasks.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="trash">
                回收站
                <span className="text-xs text-muted-foreground">
                  {deletedTasks.length}
                </span>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:max-w-xl sm:flex-row sm:justify-end">
            <label className="relative block min-w-0 flex-1 sm:max-w-xs">
              <span className="sr-only">搜索定时任务</span>
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索任务或工作区"
                className="pl-8"
              />
            </label>
            {view === 'trash' && purgeableDeletedTasks.length > 0 && (
              <Button
                variant="destructive"
                onClick={() =>
                  setPendingAction({
                    kind: 'purge',
                    ids: purgeableDeletedTasks.map((task) => task.id),
                  })
                }
              >
                <Trash2 />
                清空回收站
              </Button>
            )}
          </div>
        </div>

        {loading && tasks.length === 0 ? (
          <SkeletonCardList count={4} />
        ) : view === 'current' ? (
          renderCurrentTasks()
        ) : (
          renderTrash()
        )}
      </div>

      {showCreateForm && (
        <CreateTaskForm
          onSubmit={handleCreateTask}
          onClose={() => {
            setShowCreateForm(false);
            loadTasks();
          }}
          isAdmin={isAdmin}
        />
      )}

      <ConfirmDialog
        open={!!pendingAction}
        onClose={() => {
          if (!actionLoading) setPendingAction(null);
        }}
        onConfirm={executePendingAction}
        title={
          pendingIsPurge
            ? pendingCount === 1
              ? `永久删除“${pendingTask ? taskTitle(pendingTask) : '这个任务'}”？`
              : `清空回收站中的 ${pendingCount} 个任务？`
            : `将“${pendingTask ? taskTitle(pendingTask) : '这个任务'}”移到回收站？`
        }
        message={
          pendingIsPurge
            ? '任务定义和全部运行历史都会被永久删除，此操作无法撤销。'
            : '任务将停止后续触发，但会保留配置和运行历史；你可以稍后从回收站恢复。'
        }
        confirmText={
          pendingIsPurge
            ? pendingCount === 1
              ? '永久删除任务'
              : `永久删除 ${pendingCount} 个任务`
            : '移到回收站'
        }
        confirmVariant="danger"
        loading={actionLoading}
      />
    </div>
  );
}
