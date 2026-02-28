import { useEffect, useState } from 'react';
import { useTasksStore } from '../stores/tasks';
import { useScriptsStore } from '../stores/scripts';
import { useChatStore } from '../stores/chat';
import { TaskCard } from '../components/tasks/TaskCard';
import { ScriptCard } from '../components/tasks/ScriptCard';
import { CreateTaskForm } from '../components/tasks/CreateTaskForm';
import { Plus, RefreshCw, Clock, X, FileCode } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '../stores/auth';

export function TasksPage() {
  const { tasks, loading, error, loadTasks, createTask, updateTaskStatus, deleteTask } = useTasksStore();
  const {
    scripts,
    loading: scriptsLoading,
    actionLoading,
    error: scriptsError,
    loadScripts,
    startScript,
    stopScript,
    restartScript,
    deleteScript: deleteScriptAction,
  } = useScriptsStore();
  const { groups, loadGroups } = useChatStore();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [showCreateForm, setShowCreateForm] = useState(false);

  useEffect(() => {
    loadTasks();
    loadGroups();
    if (isAdmin) loadScripts();
  }, [loadTasks, loadGroups, loadScripts, isAdmin]);

  const handleCreateTask = async (data: {
    groupFolder: string;
    chatJid: string;
    prompt: string;
    scheduleType: 'cron' | 'interval' | 'once';
    scheduleValue: string;
    contextMode: 'group' | 'isolated';
  }) => {
    await createTask(
      data.groupFolder,
      data.chatJid,
      data.prompt,
      data.scheduleType,
      data.scheduleValue,
      data.contextMode
    );
    setShowCreateForm(false);
  };

  const handlePause = async (id: string) => {
    if (confirm('确定要暂停此任务吗？')) {
      await updateTaskStatus(id, 'paused');
    }
  };

  const handleResume = async (id: string) => {
    if (confirm('确定要恢复此任务吗？')) {
      await updateTaskStatus(id, 'active');
    }
  };

  const handleDelete = async (id: string) => {
    if (confirm('确定要删除此任务吗？此操作不可撤销。')) {
      await deleteTask(id);
    }
  };

  const handleDeleteScript = async (id: string) => {
    if (confirm('确定要删除此脚本吗？进程将被终止并从监控面板移除。')) {
      await deleteScriptAction(id);
    }
  };

  const groupsList = Object.entries(groups).map(([jid, group]) => ({
    jid,
    name: group.name,
    folder: group.folder,
  }));

  const activeTasks = tasks.filter((t) => t.status === 'active');
  const pausedTasks = tasks.filter((t) => t.status === 'paused');
  const otherTasks = tasks.filter((t) => t.status !== 'active' && t.status !== 'paused');

  const handleRefreshAll = () => {
    loadTasks();
    loadScripts();
  };

  const anyError = error || scriptsError;

  return (
    <div className="min-h-full bg-slate-50">
      <div className="max-w-6xl mx-auto p-6">
        <PageHeader
          title="任务管理"
          subtitle={`${scripts.length} 个脚本 · ${tasks.length} 个定时任务 · ${activeTasks.length} 运行中`}
          className="mb-6"
          actions={
            <div className="flex items-center gap-3">
              <Button variant="outline" onClick={handleRefreshAll} disabled={loading || scriptsLoading}>
                <RefreshCw size={18} className={loading || scriptsLoading ? 'animate-spin' : ''} />
                刷新
              </Button>
              <Button onClick={() => setShowCreateForm(true)}>
                <Plus size={18} />
                创建任务
              </Button>
            </div>
          }
        />

        {anyError && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 flex items-center justify-between">
            <span className="text-sm text-red-700">{anyError}</span>
            <button
              onClick={() => {
                useTasksStore.setState({ error: null });
                useScriptsStore.setState({ error: null });
              }}
              className="p-1 text-red-400 hover:text-red-600 rounded transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        )}

        <div className="space-y-6">
          {/* Scripts monitoring section */}
          {scripts.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <FileCode size={16} className="text-slate-500" />
                <h2 className="text-sm font-semibold text-slate-700">脚本监控</h2>
                <span className="text-xs text-slate-400">
                  {scripts.filter((s) => s.status === 'online').length}/{scripts.length} 运行中
                </span>
              </div>
              <div className="space-y-2">
                {scripts.map((script) => (
                  <ScriptCard
                    key={script.id}
                    script={script}
                    actionLoading={actionLoading}
                    onStart={startScript}
                    onStop={stopScript}
                    onRestart={restartScript}
                    onDelete={handleDeleteScript}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Scheduled tasks sections */}
          {loading && tasks.length === 0 ? (
            <SkeletonCardList count={4} />
          ) : tasks.length === 0 && scripts.length === 0 ? (
            <EmptyState
              icon={Clock}
              title="还没有创建任何任务"
              action={
                <Button onClick={() => setShowCreateForm(true)}>
                  <Plus size={18} />
                  创建第一个任务
                </Button>
              }
            />
          ) : (
            <>
              {activeTasks.length > 0 && (
                <div>
                  <h2 className="text-sm font-semibold text-slate-700 mb-3">运行中</h2>
                  <div className="space-y-3">
                    {activeTasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onPause={handlePause}
                        onResume={handleResume}
                        onDelete={handleDelete}
                      />
                    ))}
                  </div>
                </div>
              )}

              {pausedTasks.length > 0 && (
                <div>
                  <h2 className="text-sm font-semibold text-slate-700 mb-3">已暂停</h2>
                  <div className="space-y-3">
                    {pausedTasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onPause={handlePause}
                        onResume={handleResume}
                        onDelete={handleDelete}
                      />
                    ))}
                  </div>
                </div>
              )}

              {otherTasks.length > 0 && (
                <div>
                  <h2 className="text-sm font-semibold text-slate-700 mb-3">其他</h2>
                  <div className="space-y-3">
                    {otherTasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onPause={handlePause}
                        onResume={handleResume}
                        onDelete={handleDelete}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {showCreateForm && (
        <CreateTaskForm
          groups={groupsList}
          onSubmit={handleCreateTask}
          onClose={() => setShowCreateForm(false)}
        />
      )}
    </div>
  );
}
