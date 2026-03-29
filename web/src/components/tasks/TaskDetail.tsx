import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Pencil, RefreshCw, X } from 'lucide-react';
import { ScheduledTask, TaskRunLog, useTasksStore } from '../../stores/tasks';
import { showToast } from '../../utils/toast';
import { INTERVAL_UNITS, formatInterval, decomposeInterval, toggleNotifyChannel } from '../../utils/task-utils';
import { useConnectedChannels } from '../../hooks/useConnectedChannels';

const CHANNEL_LABELS: Record<string, string> = {
  feishu: '飞书',
  telegram: 'Telegram',
  qq: 'QQ',
  wechat: '微信',
};

interface TaskDetailProps {
  task: ScheduledTask;
}

const LOG_STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  running: { bg: 'bg-blue-100', text: 'text-blue-700', label: '运行中' },
  success: { bg: 'bg-green-100', text: 'text-green-700', label: '成功' },
  error: { bg: 'bg-red-100', text: 'text-red-700', label: '失败' },
};

function RunLogStatusBadge({ status }: { status: string }) {
  const style = LOG_STATUS_STYLES[status] || { bg: 'bg-muted', text: 'text-muted-foreground', label: status };
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${style.bg} ${style.text}`}>
      {style.label}
    </span>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

export function TaskDetail({ task }: TaskDetailProps) {
  const { updateTask, loadLogs, logs } = useTasksStore();

  const connectedChannels = useConnectedChannels();
  const taskLogs = logs[task.id] || [];
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    loadLogs(task.id);
  }, [task.id, loadLogs]);

  const handleRefreshLogs = async () => {
    setLogsLoading(true);
    try {
      await loadLogs(task.id);
    } finally {
      setLogsLoading(false);
    }
  };

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editForm, setEditForm] = useState({
    prompt: task.prompt,
    script_command: task.script_command || '',
    schedule_type: task.schedule_type,
    schedule_value: task.schedule_value,
    notify_channels: task.notify_channels ?? null,
  });

  // Interval editing: decompose ms into number + unit
  const initialInterval = useMemo(
    () => decomposeInterval(task.schedule_value),
    [task.schedule_value],
  );
  const [intervalNum, setIntervalNum] = useState(initialInterval.num);
  const [intervalUnit, setIntervalUnit] = useState(initialInterval.unitMs);

  // Sync form when task prop changes (e.g. after save)
  useEffect(() => {
    if (!editing) {
      setEditForm({
        prompt: task.prompt,
        script_command: task.script_command || '',
        schedule_type: task.schedule_type,
        schedule_value: task.schedule_value,
        notify_channels: task.notify_channels ?? null,
      });
      const decomposed = decomposeInterval(task.schedule_value);
      setIntervalNum(decomposed.num);
      setIntervalUnit(decomposed.unitMs);
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
      // For interval type, compute ms from number + unit
      const effectiveValue =
        editForm.schedule_type === 'interval' && intervalNum
          ? String(parseInt(intervalNum, 10) * parseInt(intervalUnit, 10))
          : editForm.schedule_value;
      if (effectiveValue !== task.schedule_value)
        fields.schedule_value = effectiveValue;
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
      notify_channels: task.notify_channels ?? null,
    });
    const decomposed = decomposeInterval(task.schedule_value);
    setIntervalNum(decomposed.num);
    setIntervalUnit(decomposed.unitMs);
    setEditing(false);
  };

  const connectedKeys = Object.keys(connectedChannels).filter(
    (k) => connectedChannels[k],
  );

  const toggleChannel = (ch: string) => {
    setEditForm((prev) => ({
      ...prev,
      notify_channels: toggleNotifyChannel(prev.notify_channels, ch, connectedKeys),
    }));
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

  const scheduleLabel = () => {
    const type = editing ? editForm.schedule_type : task.schedule_type;
    if (type === 'cron') return 'Cron 表达式';
    if (type === 'interval') return '执行间隔';
    if (type === 'once') return '执行时间';
    return '调度值';
  };

  const formatScheduleValue = (type: string, value: string) => {
    if (type === 'interval') return formatInterval(value);
    if (type === 'once') return formatDate(value);
    return value; // cron — show raw expression
  };

  const isChannelSelected = (ch: string) => {
    if (editForm.notify_channels === null) return true;
    return editForm.notify_channels.includes(ch);
  };

  const renderNotifyChannelsBadges = () => {
    const channels = task.notify_channels;
    // null means all connected channels
    if (channels === null || channels === undefined) {
      const connectedKeys = Object.entries(connectedChannels)
        .filter(([, v]) => v)
        .map(([k]) => k);
      return (
        <div className="flex flex-wrap gap-1">
          <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground">
            Web
          </span>
          {connectedKeys.map((key) => (
            <span
              key={key}
              className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-brand-50 text-primary"
            >
              {CHANNEL_LABELS[key] || key}
            </span>
          ))}
        </div>
      );
    }
    if (channels.length === 0) {
      return (
        <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground">
          仅 Web
        </span>
      );
    }
    return (
      <div className="flex flex-wrap gap-1">
        <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground">
          Web
        </span>
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
              onChange={(e) =>
                setEditForm({ ...editForm, script_command: e.target.value })
              }
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
            onChange={(e) =>
              setEditForm({ ...editForm, prompt: e.target.value })
            }
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
                setEditForm({
                  ...editForm,
                  schedule_type: e.target.value as 'cron' | 'interval' | 'once',
                })
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
          <div className="text-xs text-muted-foreground mb-1">
            {scheduleLabel()}
          </div>
          {editing ? (
            <>
              {editForm.schedule_type === 'interval' ? (
                <div className="flex gap-2">
                  <input
                    type="number"
                    min="1"
                    value={intervalNum}
                    onChange={(e) => setIntervalNum(e.target.value)}
                    className="flex-1 text-sm text-foreground bg-card px-2 py-1 rounded border border-border font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                    placeholder="数值"
                  />
                  <select
                    value={intervalUnit}
                    onChange={(e) => setIntervalUnit(e.target.value)}
                    className="w-20 text-sm text-foreground bg-card px-2 py-1 rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    {INTERVAL_UNITS.map((u) => (
                      <option key={u.ms} value={String(u.ms)}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <input
                  type="text"
                  value={editForm.schedule_value}
                  onChange={(e) =>
                    setEditForm({ ...editForm, schedule_value: e.target.value })
                  }
                  className="w-full text-sm text-foreground bg-card px-2 py-1 rounded border border-border font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                />
              )}
              {editForm.schedule_type === 'cron' && (
                <p className="mt-1 text-xs text-muted-foreground">
                  格式: 分 时 日 月 星期（北京时间）
                </p>
              )}
            </>
          ) : (
            <div className="text-sm text-foreground">
              {task.schedule_type === 'cron' ? (
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                  {task.schedule_value}
                </code>
              ) : (
                formatScheduleValue(task.schedule_type, task.schedule_value)
              )}
            </div>
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

        {task.execution_mode && (
          <div>
            <div className="text-xs text-muted-foreground mb-1">执行模式</div>
            <div className="text-sm text-foreground">
              {task.execution_mode === 'host' ? '宿主机' : 'Docker 容器'}
            </div>
          </div>
        )}

        {task.workspace_folder && (
          <div>
            <div className="text-xs text-muted-foreground mb-1">任务工作区</div>
            <Link
              to={`/chat/${task.workspace_folder}`}
              className="text-sm text-primary hover:underline"
            >
              {task.workspace_folder}
            </Link>
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
              {Object.entries(CHANNEL_LABELS)
                .filter(([key]) => connectedChannels[key])
                .map(([key, label]) => (
                  <label
                    key={key}
                    className="inline-flex items-center gap-1 text-sm text-foreground cursor-pointer"
                  >
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
      </div>

      {/* Execution Logs */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm text-muted-foreground">执行日志</div>
          <button
            onClick={handleRefreshLogs}
            disabled={logsLoading}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
            title="刷新日志"
          >
            <RefreshCw className={`w-4 h-4 ${logsLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {taskLogs.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无执行记录</p>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-brand-50 text-primary text-xs">
                  <th className="text-left px-4 py-2 font-medium">运行时间</th>
                  <th className="text-left px-4 py-2 font-medium">耗时</th>
                  <th className="text-left px-4 py-2 font-medium">状态</th>
                  <th className="text-left px-4 py-2 font-medium">结果</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {taskLogs.map((log: TaskRunLog) => (
                  <tr key={log.id}>
                    <td className="px-4 py-2.5 text-foreground whitespace-nowrap">
                      {formatDate(log.run_at)}
                    </td>
                    <td className="px-4 py-2.5 text-foreground whitespace-nowrap">
                      {log.status === 'running' ? '-' : formatDuration(log.duration_ms)}
                    </td>
                    <td className="px-4 py-2.5">
                      <RunLogStatusBadge status={log.status} />
                    </td>
                    <td className="px-4 py-2.5 text-foreground truncate max-w-xs" title={log.error || log.result || ''}>
                      {log.error ? (
                        <span className="text-red-600">{log.error.slice(0, 100)}</span>
                      ) : log.result ? (
                        log.result.slice(0, 100)
                      ) : log.status === 'running' ? (
                        <span className="text-muted-foreground">执行中...</span>
                      ) : (
                        ''
                      )}
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
