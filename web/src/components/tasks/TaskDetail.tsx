import { useEffect } from 'react';
import { ScheduledTask, useTasksStore } from '../../stores/tasks';

interface TaskDetailProps {
  task: ScheduledTask;
}

export function TaskDetail({ task }: TaskDetailProps) {
  const { logs, loadLogs } = useTasksStore();
  const taskLogs = logs[task.id] || [];

  useEffect(() => {
    loadLogs(task.id);
  }, [task.id, loadLogs]);

  const formatDate = (timestamp: string | null | undefined) => {
    if (!timestamp) return '-';
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) return timestamp;
    return parsed.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  };

  return (
    <div className="p-4 bg-slate-50 space-y-4">
      {/* Script Command (script mode) */}
      {task.execution_type === 'script' && task.script_command && (
        <div>
          <div className="text-xs text-slate-500 mb-2">脚本命令</div>
          <pre className="text-sm text-slate-900 bg-white px-3 py-2 rounded border border-slate-200 whitespace-pre-wrap font-mono">
            {task.script_command}
          </pre>
        </div>
      )}

      {/* Full Prompt / Description */}
      {task.prompt && (
        <div>
          <div className="text-xs text-slate-500 mb-2">
            {task.execution_type === 'script' ? '任务描述' : '完整 Prompt'}
          </div>
          <div className="text-sm text-slate-900 bg-white px-3 py-2 rounded border border-slate-200 whitespace-pre-wrap">
            {task.prompt}
          </div>
        </div>
      )}

      {/* Schedule Details */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-slate-500 mb-1">执行方式</div>
          <div className="text-sm text-slate-900">
            {task.execution_type === 'script' ? '脚本' : 'Agent'}
          </div>
        </div>

        <div>
          <div className="text-xs text-slate-500 mb-1">调度类型</div>
          <div className="text-sm text-slate-900">
            {task.schedule_type === 'cron' && 'Cron 表达式'}
            {task.schedule_type === 'interval' && '间隔执行'}
            {task.schedule_type === 'once' && '单次执行'}
          </div>
        </div>

        <div>
          <div className="text-xs text-slate-500 mb-1">调度值</div>
          <code className="text-sm text-slate-900 bg-white px-2 py-1 rounded border border-slate-200">
            {task.schedule_value}
          </code>
        </div>

        <div>
          <div className="text-xs text-slate-500 mb-1">下次运行</div>
          <div className="text-sm text-slate-900">
            {formatDate(task.next_run)}
          </div>
        </div>

        {task.last_run && (
          <div>
            <div className="text-xs text-slate-500 mb-1">上次运行</div>
            <div className="text-sm text-slate-900">
              {formatDate(task.last_run)}
            </div>
          </div>
        )}

        {task.execution_type !== 'script' && (
          <div>
            <div className="text-xs text-slate-500 mb-1">上下文模式</div>
            <div className="text-sm text-slate-900">
              {task.context_mode === 'group'
                ? '共享群组上下文'
                : task.context_mode === 'isolated'
                  ? '独立执行'
                  : task.context_mode}
            </div>
          </div>
        )}

        <div>
          <div className="text-xs text-slate-500 mb-1">创建时间</div>
          <div className="text-sm text-slate-900">
            {formatDate(task.created_at)}
          </div>
        </div>

        {task.last_result && (
          <div className="col-span-1 md:col-span-2">
            <div className="text-xs text-slate-500 mb-1">最近结果</div>
            <div className="text-sm text-slate-900 bg-white px-3 py-2 rounded border border-slate-200 whitespace-pre-wrap break-words">
              {task.last_result}
            </div>
          </div>
        )}
      </div>

      {/* Execution Logs */}
      <div>
        <div className="text-xs text-slate-500 mb-2">执行日志</div>
        {taskLogs.length === 0 ? (
          <div className="text-sm text-slate-400 bg-white px-3 py-4 rounded border border-slate-200 text-center">
            暂无执行记录
          </div>
        ) : (
          <div className="overflow-x-auto bg-white rounded border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-slate-500">
                    运行时间
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-slate-500">
                    耗时
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-slate-500">
                    状态
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-slate-500">
                    结果
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {taskLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 text-slate-900 whitespace-nowrap">
                      {formatDate(log.run_at)}
                    </td>
                    <td className="px-3 py-2 text-slate-900 whitespace-nowrap">
                      {formatDuration(log.duration_ms)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                          log.status === 'success'
                            ? 'bg-green-100 text-green-600'
                            : 'bg-red-100 text-red-600'
                        }`}
                      >
                        {log.status === 'success' ? '成功' : '失败'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-900 max-w-xs truncate">
                      {log.status === 'success'
                        ? log.result || '-'
                        : log.error || '未知错误'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
