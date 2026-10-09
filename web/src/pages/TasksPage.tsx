import { useEffect, useRef, useState } from 'react';
import { Clock, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { TaskCard } from '../components/tasks/TaskCard';
import { TaskDetail } from '../components/tasks/TaskDetail';
import { CreateTaskForm } from '../components/tasks/CreateTaskForm';
import { useTasksStore, type ScheduledTask } from '../stores/tasks';
import { useAuthStore } from '../stores/auth';
import { useGroupsStore } from '../stores/groups';
import { showToast } from '../utils/toast';
import { confirmDialog } from '@/stores/confirm';
import { useVisibleInterval } from '../hooks/useVisibleInterval';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { IconButton } from '@/components/common/IconButton';
import { ListGroup } from '@/components/common/ListRow';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { SearchInput } from '@/components/common/SearchInput';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

type TaskView = 'current' | 'trash';

// Page-level empty states sit in the same bordered surface as the list.
const PAGE_EMPTY_CLASS = 'bg-surface-raised ring-1 ring-surface-border';
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
  // The detail sheet keeps rendering the last task while it animates out.
  const [detail, setDetail] = useState<{
    id: string;
    edit: boolean;
    nonce: number;
  } | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const detailNonce = useRef(0);
  const isAdmin = user?.role === 'admin';

  const openDetail = (id: string, options?: { edit?: boolean }) => {
    detailNonce.current += 1;
    setDetail({ id, edit: !!options?.edit, nonce: detailNonce.current });
    setDetailOpen(true);
  };

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
  // Settled runs keep their notification_available_at timestamp; only pending
  // notifications or a retry scheduled in the future need polling.
  const hasNotificationWork = tasks.some((task) => {
    const summary = task.last_run_summary;
    if (summary?.notification_status === 'pending') return true;
    const availableAt = summary?.notification_available_at;
    return !!availableAt && Date.parse(availableAt) > Date.now();
  });
  const liveRunCount = new Set([
    ...runningTaskIds,
    ...tasks
      .filter(
        (task) =>
          task.current_run && liveRunStatuses.has(task.current_run.status),
      )
      .map((task) => task.id),
  ]).size;
  useVisibleInterval(
    loadTasks,
    3000,
    hasParsing || hasRunning || hasNotificationWork,
  );

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
    );
    if (!useTasksStore.getState().error) {
      setShowCreateForm(false);
      setView('current');
    }
  };

  const handlePause = async (id: string) => {
    if (
      await confirmDialog({
        title: '暂停后续计划？',
        message:
          '当前正在运行的任务会继续执行。如需终止，请使用“停止当前运行”。',
        confirmText: '暂停',
      })
    ) {
      await updateTaskStatus(id, 'paused');
    }
  };

  const handleResume = async (id: string) => {
    const task = tasks.find((candidate) => candidate.id === id);
    const confirmed =
      task?.schedule_type === 'once'
        ? await confirmDialog({
            title: '启用这个一次性任务？',
            message: `任务会在 ${new Date(task.schedule_value).toLocaleString('zh-CN')} 执行；如果该时间已过，请先修改为未来时间。`,
            confirmText: '启用',
          })
        : await confirmDialog({
            title: '恢复后续计划',
            message: '确定要恢复此任务吗？',
            confirmText: '恢复',
          });
    if (confirmed) {
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
      await confirmDialog({
        title: '停止当前运行？',
        message:
          '本次运行会被取消，后续计划不受影响。已经完成的外部操作无法撤销。',
        confirmText: '停止运行',
        variant: 'danger',
      })
    ) {
      await stopTaskRun(runId);
    }
  };

  const handleRestore = async (id: string) => {
    if (
      !(await confirmDialog({
        title: '恢复这个任务？',
        message:
          '任务会恢复为暂停状态，不会立即触发。一次性任务若已过原定时间，需要先修改为未来时间再启用。',
        confirmText: '恢复任务',
      }))
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

  const detailTask = detail
    ? tasks.find((task) => task.id === detail.id)
    : undefined;

  const renderRows = (rows: ScheduledTask[], trash = false) => (
    <ListGroup>
      {rows.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          workspaceName={groupNames[task.chat_jid]}
          selected={detailOpen && detail?.id === task.id}
          onOpen={openDetail}
          isRunning={trash ? false : runningTaskIds.has(task.id)}
          isMutating={mutatingTaskIds.has(task.id)}
          onPause={handlePause}
          onResume={handleResume}
          onDelete={handleDelete}
          onRunNow={trash ? undefined : runTaskNow}
          onRestore={trash ? handleRestore : undefined}
          onPurge={trash ? handlePurge : undefined}
          onStopRun={handleStopRun}
        />
      ))}
    </ListGroup>
  );

  const renderCurrentTasks = () => {
    if (filteredLiveTasks.length === 0) {
      if (normalizedQuery) {
        return (
          <EmptyState
            className={PAGE_EMPTY_CLASS}
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
          className={PAGE_EMPTY_CLASS}
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
      <div className="space-y-6">
        {currentSections.map(
          (section) =>
            section.tasks.length > 0 && (
              <section
                key={section.key}
                aria-labelledby={`${section.key}-tasks`}
              >
                <h2
                  id={`${section.key}-tasks`}
                  className="mb-2 flex items-center gap-1.5 px-1 text-caption font-medium text-muted-foreground"
                >
                  {section.title}
                  <span className="font-normal text-faint-foreground tabular-nums">
                    {section.tasks.length}
                  </span>
                </h2>
                {renderRows(section.tasks)}
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
          className={PAGE_EMPTY_CLASS}
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
        {renderRows(filteredDeletedTasks, true)}
      </section>
    );
  };

  return (
    <PageContainer size="wide">
      <PageHeader
        title="任务"
        // Non-breaking spaces and keep-all wrap the subtitle only between
        // "·"-separated counts, never inside one of them.
        className="[&_p]:break-keep"
        subtitle={`当前\u00a0${liveTasks.length} · ${enabledTasks.length}\u00a0已启用 · ${pausedTasks.length}\u00a0已暂停 · ${liveRunCount}\u00a0执行中${retryingCount > 0 ? ` · ${retryingCount}\u00a0等待重试` : ''} · 回收站\u00a0${deletedTasks.length}`}
        actions={
          <>
            <IconButton
              label="刷新"
              icon={<RefreshCw className={cn(loading && 'animate-spin')} />}
              variant="outline"
              size="icon"
              onClick={loadTasks}
              disabled={loading}
            />
            <Button onClick={() => setShowCreateForm(true)}>
              <Plus />
              新建任务
            </Button>
          </>
        }
      />

      {error && (
        <div
          role="alert"
          className="mt-4 flex items-start justify-between gap-3 rounded-lg bg-error/10 px-3 py-2.5 text-body text-error"
        >
          <span className="min-w-0 py-0.5">{error}</span>
          <IconButton
            label="关闭错误提示"
            icon={<X />}
            size="icon-xs"
            hideTooltip
            onClick={() => useTasksStore.setState({ error: null })}
            className="text-error hover:bg-error/10 hover:text-error"
          />
        </div>
      )}

      <div className="mt-6 mb-5 flex flex-col-reverse gap-3 border-b border-surface-border sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <Tabs
          value={view}
          onValueChange={(value) => setView(value as TaskView)}
          className="self-stretch"
        >
          <TabsList
            variant="line"
            aria-label="任务视图"
            className="h-10 gap-4 p-0 group-data-horizontal/tabs:h-10"
          >
            <TabsTrigger
              value="current"
              className="flex-none px-0.5 group-data-horizontal/tabs:after:-bottom-px"
            >
              当前任务
              <span className="text-caption font-normal text-muted-foreground tabular-nums">
                {liveTasks.length}
              </span>
            </TabsTrigger>
            <TabsTrigger
              value="trash"
              className="flex-none px-0.5 group-data-horizontal/tabs:after:-bottom-px"
            >
              回收站
              <span className="text-caption font-normal text-muted-foreground tabular-nums">
                {deletedTasks.length}
              </span>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex min-w-0 items-center gap-2 sm:pb-1">
          <SearchInput
            value={query}
            onChange={setQuery}
            debounce={150}
            placeholder="搜索任务或工作区"
            ariaLabel="搜索定时任务"
            className="min-w-0 flex-1 sm:w-64 sm:flex-none"
          />
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
        <TaskListSkeleton />
      ) : view === 'current' ? (
        renderCurrentTasks()
      ) : (
        renderTrash()
      )}

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

      <Sheet open={detailOpen && !!detailTask} onOpenChange={setDetailOpen}>
        <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
          {detail && detailTask && (
            <TaskDetail
              key={`${detail.id}:${detail.nonce}`}
              task={detailTask}
              initialEditing={detail.edit}
            />
          )}
        </SheetContent>
      </Sheet>

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
    </PageContainer>
  );
}

function TaskListSkeleton() {
  return (
    <ListGroup aria-busy="true" aria-label="正在加载任务">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="size-8 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-48 max-w-full" />
            <Skeleton className="h-3 w-72 max-w-full" />
          </div>
          <Skeleton className="hidden h-3 w-24 sm:block" />
        </div>
      ))}
    </ListGroup>
  );
}
