import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Pencil, RefreshCw, X } from 'lucide-react';
import { ScheduledTask, useTasksStore } from '../../stores/tasks';
import { showToast } from '../../utils/toast';

const CHANNEL_LABELS: Record<string, string> = {
  feishu: '飞书',
  telegram: 'Telegram',
  qq: 'QQ',
  wechat: '微信',
};

interface TaskDetailProps {
  task: ScheduledTask;
}

export function TaskDetail({ task }: TaskDetailProps) {
  const { logs, loadLogs, updateTask, runningTaskIds } = useTasksStore();
  const taskLogs = logs[task.id] || [];
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const isRunning = runningTaskIds.has(task.id);

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editForm, setEditForm] = useState({
    prompt: task.prompt,
    script_command: task.script_command || '',
    schedule_type: task.schedule_type,
    schedule_value: task.schedule_value,
    context_mode: task.context_mode,
    notify_channels: task.notify_channels ?? null,
  });

  useEffect(() => {
    loadLogs(task.id);
    pollRef.current = setInterval(() => loadLogs(task.id), 10000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [task.id, loadLogs]);

  // Sync form when task prop changes (e.g. after save)
  useEffect(() => {
    if (!editing) {
      setEditForm({
        prompt: task.prompt,
        script_command: task.script_command || '',
        schedule_type: task.schedule_type,
        schedule_value: task.schedule_value,
        context_mode: task.context_mode,
        notify_channels: task.notify_channels ?? null,
      });
    }
  }, [task, editing]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const fields: Record<string, unknown> = {};
      if (editForm.prompt !== task.prompt) fields.prompt = editForm.prompt;
      if (editForm.script_command !== (task.script_command || ''))
        fields.script_command = editForm.script_command || null;
      if (editForm.schedule_type !== task.schedule_type)
        fields.schedule_type = editForm.schedule_type;
      if (editForm.schedule_value !== task.schedule_value)
        fields.schedule_value = editForm.schedule_value;
      if (editForm.context_mode !== task.context_mode)
        fields.context_mode = editForm.context_mode;
      // notify_channels: compare serialized
      const oldChannels = JSON.stringify(task.notify_channels ?? null);
      const newChannels = JSON.stringify(editForm.notify_channels);
      if (oldChannels !== newChannels)
        fields.notify_channels = editForm.notify_channels;

      if (Object.keys(fields).length > 0) {
        await updateTask(task.id, fields);
        showToast('保存成功', '任务已更新');
      }
      setEditing(false);
    } catch {
      showToast('保存失败', '请稍后重试');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditForm({
      prompt: task.prompt,
      script_command: task.script_command || '',
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      context_mode: task.context_mode,
      notify_channels: task.notify_channels ?? null,
    });
    setEditing(false);
  };

  const toggleChannel = (ch: string) => {
    setEditForm((prev) => {
      const current = prev.notify_channels;
      if (current === null) {
        // Was "all" → switch to all except this one
        const all = Object.keys(CHANNEL_LABELS);
        return { ...prev, notify_channels: all.filter((c) => c !== ch) };
      }
      if (current.includes(ch)) {
        const next = current.filter((c) => c !== ch);
        return { ...prev, notify_channels: next.length === 0 ? [] : next };
      }
      const next = [...current, ch];
      // If all selected, set to null (= all)
      if (next.length === Object.keys(CHANNEL_LABELS).length) {
        return { ...prev, notify_channels: null };
      }
      return { ...prev, notify_channels: next };
    });
  };

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

  const isChannelSelected = (ch: string) => {
    if (editForm.notify_channels === null) return true;
    return editForm.notify_channels.includes(ch);
  };

  const renderNotifyChannelsBadges = () => {
    const channels = task.notify_channels;
    if (channels === null || channels === undefined) {
      return <span className="text-sm text-foreground">所有渠道</span>;
    }
    if (channels.length === 0) {
      return <span className="text-sm text-muted-foreground">仅 Web</span>;
    }
    return (
      <div className="flex flex-wrap gap-1">
        {channels.map((ch) => (
          <span
            key={ch}
            className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-brand-50 text-primary"
          >
            {CHANNEL_LABELS[ch] || ch}
          </span>
        ))}
      </div>
    );
  };

  return (
    <div className="p-4 bg-background space-y-4">
      {/* Edit Toggle */}
      <div className="flex items-center justify-end gap-2">
        {editing ? (
          <>
            <button
              onClick={handleCancel}
              disabled={saving}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-muted-foreground bg-muted hover:bg-muted/80 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
            >
              <X className="w-3.5 h-3.5" /> 取消
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-primary hover:bg-primary/90 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
            >
              <Check className="w-3.5 h-3.5" /> {saving ? '保存中...' : '保存'}
            </button>
          </>
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-primary hover:bg-brand-50 rounded-lg transition-colors cursor-pointer"
          >
            <Pencil className="w-3.5 h-3.5" /> 编辑
          </button>
        )}
      </div>

      {/* Script Command (script mode) */}
      {task.execution_type === 'script' && (
        <div>
          <div className="text-xs text-muted-foreground mb-2">脚本命令</div>
          {editing ? (
            <textarea
              value={editForm.script_command}
              onChange={(e) => setEditForm({ ...editForm, script_command: e.target.value })}
              rows={3}
              maxLength={4096}
              className="w-full text-sm text-foreground bg-card px-3 py-2 rounded border border-border font-mono resize-none focus:outline-none focus:ring-1 focus:ring-primary"
            />
          ) : (
            task.script_command && (
              <pre className="text-sm text-foreground bg-card px-3 py-2 rounded border border-border whitespace-pre-wrap font-mono">
                {task.script_command}
              </pre>
            )
          )}
        </div>
      )}

      {/* Full Prompt / Description */}
      <div>
        <div className="text-xs text-muted-foreground mb-2">
          {task.execution_type === 'script' ? '任务描述' : '完整 Prompt'}
        </div>
        {editing ? (
          <textarea
            value={editForm.prompt}
            onChange={(e) => setEditForm({ ...editForm, prompt: e.target.value })}
            rows={6}
            className="w-full text-sm text-foreground bg-card px-3 py-2 rounded border border-border resize-y min-h-[160px] max-h-[400px] overflow-y-auto focus:outline-none focus:ring-1 focus:ring-primary"
          />
        ) : (
          task.prompt && (
            <div className="text-sm text-foreground bg-card px-3 py-2 rounded border border-border whitespace-pre-wrap max-h-[300px] overflow-y-auto">
              {task.prompt}
            </div>
          )
        )}
      </div>

      {/* Schedule Details */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-muted-foreground mb-1">执行方式</div>
          <div className="text-sm text-foreground">
            {task.execution_type === 'script' ? '脚本' : 'Agent'}
          </div>
        </div>

        <div>
          <div className="text-xs text-muted-foreground mb-1">调度类型</div>
          {editing ? (
            <select
              value={editForm.schedule_type}
              onChange={(e) =>
                setEditForm({ ...editForm, schedule_type: e.target.value as 'cron' | 'interval' | 'once' })
              }
              className="w-full text-sm text-foreground bg-card px-2 py-1 rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="cron">Cron 表达式</option>
              <option value="interval">间隔执行</option>
              <option value="once">单次执行</option>
            </select>
          ) : (
            <div className="text-sm text-foreground">
              {task.schedule_type === 'cron' && 'Cron 表达式'}
              {task.schedule_type === 'interval' && '间隔执行'}
              {task.schedule_type === 'once' && '单次执行'}
            </div>
          )}
        </div>

        <div>
          <div className="text-xs text-muted-foreground mb-1">调度值</div>
          {editing ? (
            <input
              type="text"
              value={editForm.schedule_value}
              onChange={(e) => setEditForm({ ...editForm, schedule_value: e.target.value })}
              className="w-full text-sm text-foreground bg-card px-2 py-1 rounded border border-border font-mono focus:outline-none focus:ring-1 focus:ring-primary"
            />
          ) : (
            <code className="text-sm text-foreground bg-card px-2 py-1 rounded border border-border">
              {task.schedule_value}
            </code>
          )}
        </div>

        <div>
          <div className="text-xs text-muted-foreground mb-1">下次运行</div>
          <div className="text-sm text-foreground">
            {formatDate(task.next_run)}
          </div>
        </div>

        {task.last_run && (
          <div>
            <div className="text-xs text-muted-foreground mb-1">上次运行</div>
            <div className="text-sm text-foreground">
              {formatDate(task.last_run)}
            </div>
          </div>
        )}

        {task.execution_type !== 'script' && (
          <div>
            <div className="text-xs text-muted-foreground mb-1">上下文模式</div>
            {editing ? (
              <select
                value={editForm.context_mode}
                onChange={(e) =>
                  setEditForm({ ...editForm, context_mode: e.target.value as 'group' | 'isolated' })
                }
                className="w-full text-sm text-foreground bg-card px-2 py-1 rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="isolated">独立执行</option>
                <option value="group">共享群组上下文</option>
              </select>
            ) : (
              <div className="text-sm text-foreground">
                {task.context_mode === 'group'
                  ? '共享群组上下文'
                  : task.context_mode === 'isolated'
                    ? '独立执行'
                    : task.context_mode}
              </div>
            )}
          </div>
        )}

        <div>
          <div className="text-xs text-muted-foreground mb-1">创建时间</div>
          <div className="text-sm text-foreground">
            {formatDate(task.created_at)}
          </div>
        </div>

        {/* Notify Channels */}
        <div>
          <div className="text-xs text-muted-foreground mb-1">通知渠道</div>
          {editing ? (
            <div className="flex flex-wrap gap-2">
              <label className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                <input type="checkbox" checked disabled className="rounded" />
                Web
              </label>
              {Object.entries(CHANNEL_LABELS).map(([key, label]) => (
                <label key={key} className="inline-flex items-center gap-1 text-sm text-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isChannelSelected(key)}
                    onChange={() => toggleChannel(key)}
                    className="rounded"
                  />
                  {label}
                </label>
              ))}
            </div>
          ) : (
            renderNotifyChannelsBadges()
          )}
        </div>

        {task.last_result && (
          <div className="col-span-1 md:col-span-2">
            <div className="text-xs text-muted-foreground mb-1">最近结果</div>
            <div className="text-sm text-foreground bg-card px-3 py-2 rounded border border-border whitespace-pre-wrap break-words">
              {task.last_result}
            </div>
          </div>
        )}
      </div>

      {/* Execution Logs */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs text-muted-foreground">执行日志</div>
          <button
            onClick={() => loadLogs(task.id)}
            className="p-1 text-muted-foreground hover:text-primary hover:bg-brand-50 rounded transition-colors cursor-pointer"
            title="刷新日志"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        {isRunning && (
          <div className="flex items-center gap-2 text-sm text-primary bg-brand-50 px-3 py-2.5 rounded border border-brand-200 mb-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            任务执行中，等待结果...
          </div>
        )}
        {taskLogs.length === 0 && !isRunning ? (
          <div className="text-sm text-muted-foreground bg-card px-3 py-4 rounded border border-border text-center">
            暂无执行记录
          </div>
        ) : (
          <div className="overflow-x-auto bg-card rounded border border-border">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                    运行时间
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                    耗时
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                    状态
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                    结果
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {taskLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-muted/50">
                    <td className="px-3 py-2 text-foreground whitespace-nowrap">
                      {formatDate(log.run_at)}
                    </td>
                    <td className="px-3 py-2 text-foreground whitespace-nowrap">
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
                    <td className="px-3 py-2 text-foreground max-w-xs truncate">
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
