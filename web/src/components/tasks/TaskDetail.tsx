import { useEffect, useMemo, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, RefreshCw, ShieldAlert } from 'lucide-react';
import { ScheduledTask, TaskRunLog, useTasksStore } from '../../stores/tasks';
import type { ApiError } from '../../api/client';
import { showToast } from '../../utils/toast';
import {
  INTERVAL_UNITS,
  formatContextMode,
  formatInterval,
  decomposeInterval,
  toggleNotifyChannel,
} from '../../utils/task-utils';
import { useConnectedChannels } from '../../hooks/useConnectedChannels';
import { useGroupsStore } from '../../stores/groups';
import { useAuthStore } from '../../stores/auth';
import { getWorkspaceExecutionMode } from '../../utils/agent-product';
import {
  buildTaskWorkspacePatch,
  canSelectTaskExecutionMode,
  type TaskExecutionMode,
} from '../../utils/task-edit';
import {
  ChannelBadge,
  CHANNEL_LABEL,
  formatGroupLabel,
} from '../settings/channel-meta';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { IconButton } from '@/components/common/IconButton';
import { ListGroup, ListRow } from '@/components/common/ListRow';
import { SettingsSection } from '@/components/settings/SettingsLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface TaskDetailProps {
  task: ScheduledTask;
  /** Start in edit mode (from the row menu's 编辑 action). */
  initialEditing?: boolean;
}

type BadgeVariant = ComponentProps<typeof Badge>['variant'];

const LOG_STATUS_STYLES: Record<
  string,
  { variant: BadgeVariant; label: string }
> = {
  queued: {
    variant: 'neutral',
    label: '已排队',
  },
  running: {
    variant: 'info',
    label: '运行中',
  },
  recovering: {
    variant: 'info',
    label: '正在恢复',
  },
  retry_wait: {
    variant: 'warning',
    label: '等待重试',
  },
  success: {
    variant: 'success',
    label: '成功',
  },
  error: {
    variant: 'error',
    label: '失败',
  },
  failed: {
    variant: 'error',
    label: '失败',
  },
  cancelled: {
    variant: 'neutral',
    label: '已取消',
  },
  missed: {
    variant: 'warning',
    label: '已错过',
  },
  delivered: {
    variant: 'info',
    label: '已投递到主会话',
  },
};

const TRIGGER_LABEL: Record<string, string> = {
  scheduled: '计划触发',
  manual: '立即运行',
  backfill: '恢复补跑',
  retry: '自动重试',
};

const NOTIFICATION_LABEL: Record<string, string> = {
  pending: '待发送',
  success: '发送成功',
  partial_failed: '部分失败',
  failed: '发送失败',
  uncertain: '送达待确认',
  skipped: '无需通知',
};

function RunLogStatusBadge({ status }: { status: string }) {
  const style = LOG_STATUS_STYLES[status] || {
    variant: 'neutral',
    label: status,
  };
  return <Badge variant={style.variant}>{style.label}</Badge>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

/** Two-column property row: muted label on the left, value or control. */
function Property({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-caption text-muted-foreground sm:w-24 sm:pt-2">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-body text-foreground sm:flex sm:min-h-8 sm:flex-col sm:justify-center">
        {children}
        {hint && (
          <div className="mt-1 text-caption text-muted-foreground">{hint}</div>
        )}
      </dd>
    </div>
  );
}

function PropertyGroup({ children }: { children: ReactNode }) {
  return (
    <dl className="divide-y divide-surface-border overflow-hidden rounded-xl bg-surface-raised ring-1 ring-surface-border">
      {children}
    </dl>
  );
}

export function TaskDetail({ task, initialEditing = false }: TaskDetailProps) {
  const { updateTask, loadLogs, logs } = useTasksStore();

  const connectedChannels = useConnectedChannels();
  const groupNames = useTasksStore((s) => s.groupNames);
  const executionRole = useAuthStore((state) =>
    state.user?.role === 'admin' ? 'admin' : 'member',
  );
  const isAdmin = executionRole === 'admin';
  const groups = useGroupsStore((state) => state.groups);
  const adminHostOnlyMode = useGroupsStore((state) => state.adminHostOnlyMode);
  const groupsLoading = useGroupsStore((state) => state.loading);
  const groupsError = useGroupsStore((state) => state.error);
  const loadGroups = useGroupsStore((state) => state.loadGroups);
  const taskLogs = logs[task.id] || [];
  const [logsLoading, setLogsLoading] = useState(false);
  const [selectedLog, setSelectedLog] = useState<TaskRunLog | null>(null);

  useEffect(() => {
    loadLogs(task.id);
  }, [
    task.id,
    task.current_run?.updated_at,
    task.last_run_summary?.updated_at,
    loadLogs,
  ]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  const handleRefreshLogs = async () => {
    setLogsLoading(true);
    try {
      await loadLogs(task.id);
    } finally {
      setLogsLoading(false);
    }
  };

  const canEdit = !(task.deleted_at || task.permissions?.can_edit === false);
  const [editing, setEditing] = useState(initialEditing && canEdit);
  const [saving, setSaving] = useState(false);
  const [editForm, setEditForm] = useState({
    prompt: task.prompt,
    script_command: task.script_command || '',
    schedule_type: task.schedule_type,
    schedule_value: task.schedule_value,
    notify_channels: task.notify_channels ?? null,
    chat_jid: task.chat_jid,
    execution_mode: (task.execution_type === 'script'
      ? 'host'
      : (task.execution_mode ?? 'container')) as TaskExecutionMode,
    context_mode: task.context_mode,
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
        chat_jid: task.chat_jid,
        execution_mode: (task.execution_type === 'script'
          ? 'host'
          : (task.execution_mode ?? 'container')) as TaskExecutionMode,
        context_mode: task.context_mode,
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
      Object.assign(
        fields,
        buildTaskWorkspacePatch({
          currentChatJid: task.chat_jid,
          currentExecutionMode: task.execution_mode,
          targetChatJid: editForm.chat_jid,
          targetExecutionMode: editForm.execution_mode,
        }),
      );
      if (editForm.context_mode !== task.context_mode)
        fields.context_mode = editForm.context_mode;

      if (Object.keys(fields).length > 0) {
        await updateTask(task.id, fields);
        showToast('保存成功', '任务已更新');
      }
      setEditing(false);
    } catch (error) {
      const apiError = error as ApiError;
      if (apiError.status === 409) {
        showToast(
          '任务已被其他操作修改',
          '为避免覆盖最新配置，已退出编辑并重新加载。',
        );
        setEditing(false);
        await useTasksStore.getState().loadTasks();
      } else {
        showToast('保存失败', apiError.message || '请稍后重试');
      }
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
      chat_jid: task.chat_jid,
      execution_mode: (task.execution_type === 'script'
        ? 'host'
        : (task.execution_mode ?? 'container')) as TaskExecutionMode,
      context_mode: task.context_mode,
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
      notify_channels: toggleNotifyChannel(
        prev.notify_channels,
        ch,
        connectedKeys,
      ),
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

  // Runs usually start on the scheduled day, so only repeat the date when not.
  const formatRunStart = (log: TaskRunLog) => {
    const start = log.started_at ?? log.run_at;
    if (!start) return '-';
    const startDate = new Date(start);
    if (Number.isNaN(startDate.getTime())) return start;
    const scheduledDate = new Date(log.scheduled_for ?? log.run_at ?? start);
    return startDate.toDateString() === scheduledDate.toDateString()
      ? startDate.toLocaleTimeString('zh-CN', { hour12: false })
      : formatDate(start);
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
          <Badge variant="neutral">Web</Badge>
          {connectedKeys.map((key) => (
            <Badge key={key} variant="outline">
              {CHANNEL_LABEL[key] || key}
            </Badge>
          ))}
        </div>
      );
    }
    if (channels.length === 0) {
      return <Badge variant="neutral">仅 Web</Badge>;
    }
    return (
      <div className="flex flex-wrap gap-1">
        <Badge variant="neutral">Web</Badge>
        {channels.map((ch) => (
          <Badge key={ch} variant="outline">
            {CHANNEL_LABEL[ch] || ch}
          </Badge>
        ))}
      </div>
    );
  };

  const title =
    (task.prompt || '').split('\n')[0].trim().slice(0, 80).trim() ||
    task.id.slice(0, 8);
  const workspaceName = groupNames[task.chat_jid] || task.chat_jid;

  return (
    <>
      <SheetHeader className="gap-1 border-b border-surface-border pr-12">
        <div className="flex items-start justify-between gap-3">
          <SheetTitle className="min-w-0 truncate text-title">
            {title}
          </SheetTitle>
          {!editing && canEdit && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
              className="-my-0.5 shrink-0"
            >
              <Pencil />
              编辑
            </Button>
          )}
        </div>
        <SheetDescription className="truncate text-caption">
          {task.execution_type === 'script' ? '脚本' : '智能体'} ·{' '}
          {task.schedule_type === 'cron'
            ? task.schedule_value
            : task.schedule_type === 'interval'
              ? `每 ${formatInterval(task.schedule_value)}`
              : '单次执行'}{' '}
          · {workspaceName}
        </SheetDescription>
      </SheetHeader>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 pt-4 pb-6">
        {task.permissions && (
          <SettingsSection title="权限与执行范围">
            <PropertyGroup>
              <Property label="文件范围">当前工作区目录</Property>
              <Property label="执行环境">
                {task.permissions.execution_scope === 'workspace_host'
                  ? '宿主机'
                  : 'Docker 容器'}
              </Property>
              <Property label="上下文">
                {formatContextMode(task.context_mode)}
              </Property>
              <Property label="可执行操作">
                {task.permissions.can_run ? '可运行' : '仅查看'}
              </Property>
            </PropertyGroup>
            {task.permissions.risk_level === 'high' && (
              <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-caption text-warning">
                <ShieldAlert className="mt-px size-3.5 shrink-0" />
                高权限任务：可在宿主机执行 Shell 命令，仅管理员可以修改或运行。
              </p>
            )}
          </SettingsSection>
        )}

        {/* Script Command (script mode) */}
        {task.execution_type === 'script' &&
          (editing || task.script_command) && (
            <SettingsSection title="脚本命令">
              {editing ? (
                <Textarea
                  value={editForm.script_command}
                  onChange={(e) =>
                    setEditForm({ ...editForm, script_command: e.target.value })
                  }
                  rows={3}
                  maxLength={4096}
                  aria-label="脚本命令"
                  className="resize-none font-mono"
                />
              ) : (
                <pre className="whitespace-pre-wrap break-all rounded-lg bg-muted/60 px-3 py-2 font-mono text-label text-foreground">
                  {task.script_command}
                </pre>
              )}
            </SettingsSection>
          )}

        {/* Full Prompt / Description */}
        {(editing || task.prompt) && (
          <SettingsSection
            title={
              task.execution_type === 'script' ? '任务描述' : '完整 Prompt'
            }
          >
            {editing ? (
              <Textarea
                value={editForm.prompt}
                onChange={(e) =>
                  setEditForm({ ...editForm, prompt: e.target.value })
                }
                rows={6}
                aria-label={
                  task.execution_type === 'script' ? '任务描述' : '完整 Prompt'
                }
                className="field-sizing-fixed min-h-40 max-h-[400px] resize-y overflow-y-auto"
              />
            ) : (
              <div className="max-h-[300px] overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/60 px-3 py-2 text-body text-foreground">
                {task.prompt}
              </div>
            )}
          </SettingsSection>
        )}

        {/* Schedule Details */}
        <SettingsSection title="调度">
          <PropertyGroup>
            <Property label="执行方式">
              {task.execution_type === 'script' ? '脚本' : '智能体'}
            </Property>

            <Property label="调度类型">
              {editing ? (
                <Select
                  value={editForm.schedule_type}
                  onValueChange={(value) =>
                    setEditForm({
                      ...editForm,
                      schedule_type: value as 'cron' | 'interval' | 'once',
                    })
                  }
                >
                  <SelectTrigger className="w-full" aria-label="调度类型">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cron">Cron 表达式</SelectItem>
                    <SelectItem value="interval">间隔执行</SelectItem>
                    <SelectItem value="once">单次执行</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <>
                  {task.schedule_type === 'cron' && 'Cron 表达式'}
                  {task.schedule_type === 'interval' && '间隔执行'}
                  {task.schedule_type === 'once' && '单次执行'}
                </>
              )}
            </Property>

            <Property
              label={scheduleLabel()}
              hint={
                editing && isAdmin && editForm.schedule_type === 'cron'
                  ? '格式: 分 时 日 月 星期（北京时间）'
                  : undefined
              }
            >
              {editing && isAdmin ? (
                editForm.schedule_type === 'interval' ? (
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      min="1"
                      value={intervalNum}
                      onChange={(e) => setIntervalNum(e.target.value)}
                      className="flex-1 font-mono"
                      placeholder="数值"
                      aria-label="间隔数值"
                    />
                    <Select
                      value={intervalUnit}
                      onValueChange={setIntervalUnit}
                    >
                      <SelectTrigger className="w-24" aria-label="间隔单位">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {INTERVAL_UNITS.map((u) => (
                          <SelectItem key={u.ms} value={String(u.ms)}>
                            {u.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
                  <Input
                    type="text"
                    value={editForm.schedule_value}
                    onChange={(e) =>
                      setEditForm({
                        ...editForm,
                        schedule_value: e.target.value,
                      })
                    }
                    className="font-mono"
                    aria-label={scheduleLabel()}
                  />
                )
              ) : task.schedule_type === 'cron' ? (
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-caption text-muted-foreground">
                  {task.schedule_value}
                </code>
              ) : (
                formatScheduleValue(task.schedule_type, task.schedule_value)
              )}
            </Property>

            <Property label="下次运行">
              <span className="tabular-nums">{formatDate(task.next_run)}</span>
            </Property>

            {task.last_run && (
              <Property label="上次运行">
                <span className="tabular-nums">
                  {formatDate(task.last_run)}
                </span>
              </Property>
            )}

            <Property label="创建时间">
              <span className="tabular-nums">
                {formatDate(task.created_at)}
              </span>
            </Property>
          </PropertyGroup>
        </SettingsSection>

        <SettingsSection title="执行">
          <PropertyGroup>
            <Property
              label="执行模式"
              hint={
                editing && isAdmin
                  ? adminHostOnlyMode
                    ? '管理员纯宿主机模式已开启，任务固定在宿主机执行。'
                    : task.execution_type === 'script'
                      ? '脚本固定为宿主机模式；必须同时选择管理员宿主机工作区。'
                      : '切换工作区时会自动继承目标工作区模式，也可在保存前手动调整。'
                  : editing && !isAdmin
                    ? editForm.execution_mode === 'host'
                      ? '这是旧版宿主机任务；成员只能查看，执行模式仅管理员可修改。'
                      : '成员任务固定使用 Docker 容器；宿主机模式仅管理员可用。'
                    : undefined
              }
            >
              {editing && isAdmin ? (
                <Select
                  value={editForm.execution_mode}
                  disabled={
                    task.execution_type === 'script' || adminHostOnlyMode
                  }
                  onValueChange={(value) =>
                    setEditForm({
                      ...editForm,
                      execution_mode: value as TaskExecutionMode,
                    })
                  }
                >
                  <SelectTrigger className="w-full" aria-label="执行模式">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="host">宿主机</SelectItem>
                    {task.execution_type !== 'script' && !adminHostOnlyMode && (
                      <SelectItem value="container">Docker 容器</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              ) : (editing ? editForm.execution_mode : task.execution_mode) ===
                'host' ? (
                '宿主机'
              ) : (
                'Docker 容器'
              )}
            </Property>

            <Property label="会话模式">
              {editing ? (
                <Select
                  value={editForm.context_mode}
                  onValueChange={(value) =>
                    setEditForm({
                      ...editForm,
                      context_mode: value as 'group' | 'isolated',
                    })
                  }
                >
                  <SelectTrigger className="w-full" aria-label="会话模式">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="isolated">独立任务会话</SelectItem>
                    <SelectItem value="group">主会话执行</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                formatContextMode(task.context_mode)
              )}
            </Property>

            <Property
              label="所属工作区"
              hint={
                editing ? (
                  <>
                    {task.permissions?.execution_blocked_reason && (
                      <span className="block text-error">
                        {task.permissions.execution_blocked_reason}
                      </span>
                    )}
                    {groupsLoading && (
                      <span className="block">正在加载工作区执行模式…</span>
                    )}
                    {groupsError && (
                      <span className="block text-error">
                        工作区信息加载失败，请关闭编辑后重试。
                      </span>
                    )}
                  </>
                ) : undefined
              }
            >
              {editing ? (
                <Select
                  value={editForm.chat_jid}
                  onValueChange={(chatJid) => {
                    const targetExecutionMode = getWorkspaceExecutionMode(
                      groups,
                      chatJid,
                    );
                    if (!targetExecutionMode) {
                      showToast(
                        '无法切换工作区',
                        '尚未取得目标工作区的执行模式',
                      );
                      return;
                    }
                    if (
                      !canSelectTaskExecutionMode(
                        executionRole,
                        targetExecutionMode,
                      )
                    ) {
                      showToast(
                        '无法切换工作区',
                        '成员任务不能迁移到宿主机执行工作区',
                      );
                      return;
                    }
                    setEditForm({
                      ...editForm,
                      chat_jid: chatJid,
                      execution_mode: targetExecutionMode,
                    });
                  }}
                  disabled={groupsLoading || !!groupsError}
                >
                  <SelectTrigger className="w-full" aria-label="所属工作区">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(groupNames)
                      .filter(
                        ([jid]) =>
                          task.execution_type !== 'script' ||
                          groups[jid]?.execution_mode === 'host',
                      )
                      .map(([jid, name]) => (
                        <SelectItem key={jid} value={jid}>
                          {formatGroupLabel(jid, name)}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              ) : (
                <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
                  <ChannelBadge channelType={task.chat_jid.split(':')[0]} />
                  <span>{workspaceName}</span>
                  <span className="break-all text-caption text-muted-foreground">
                    ({task.chat_jid.split(':').slice(1).join(':')})
                  </span>
                </span>
              )}
            </Property>

            <Property label="工作区目录">
              <Link
                to={`/chat/${task.group_folder}`}
                className="break-all text-primary hover:underline"
              >
                {task.group_folder}
              </Link>
            </Property>

            {task.workspace_folder?.startsWith('task-') && (
              <Property label="旧版任务工作区">
                <Link
                  to={`/chat/${task.workspace_folder}`}
                  className="break-all text-primary hover:underline"
                >
                  {task.workspace_folder}
                </Link>
              </Property>
            )}

            {/* Notify Channels */}
            <Property label="通知渠道">
              {editing ? (
                <div className="flex flex-wrap gap-x-4 gap-y-2 py-1.5">
                  <label className="inline-flex items-center gap-1.5 text-body text-muted-foreground">
                    <Checkbox checked disabled />
                    Web
                  </label>
                  {Object.entries(CHANNEL_LABEL)
                    .filter(([key]) => connectedChannels[key])
                    .map(([key, label]) => (
                      <label
                        key={key}
                        className="inline-flex cursor-pointer items-center gap-1.5 text-body text-foreground"
                      >
                        <Checkbox
                          checked={isChannelSelected(key)}
                          onCheckedChange={() => toggleChannel(key)}
                        />
                        {label}
                      </label>
                    ))}
                </div>
              ) : (
                renderNotifyChannelsBadges()
              )}
            </Property>
          </PropertyGroup>
        </SettingsSection>

        {/* Execution Logs */}
        <SettingsSection
          title="执行日志"
          actions={
            <IconButton
              label="刷新日志"
              icon={<RefreshCw className={cn(logsLoading && 'animate-spin')} />}
              onClick={handleRefreshLogs}
              disabled={logsLoading}
            />
          }
        >
          {taskLogs.length === 0 ? (
            <p className="rounded-xl px-4 py-6 text-center text-caption text-muted-foreground ring-1 ring-surface-border">
              暂无执行记录
            </p>
          ) : (
            <ListGroup aria-label="执行日志">
              {taskLogs.map((log: TaskRunLog) => {
                const live = [
                  'queued',
                  'running',
                  'recovering',
                  'retry_wait',
                ].includes(log.status);
                const notification =
                  NOTIFICATION_LABEL[log.notification_status || 'skipped'] ||
                  log.notification_status;
                const preview = (log.error || log.result || '').slice(0, 100);
                return (
                  <ListRow
                    key={log.id}
                    className="min-h-0 py-2.5"
                    onClick={
                      log.error || log.result
                        ? () => setSelectedLog(log)
                        : undefined
                    }
                    title={
                      <span className="tabular-nums">
                        {formatDate(log.scheduled_for ?? log.run_at)}
                      </span>
                    }
                    badges={<RunLogStatusBadge status={log.status} />}
                    description={
                      <>
                        <span className="block truncate">
                          {TRIGGER_LABEL[log.trigger_type || 'scheduled'] ||
                            log.trigger_type ||
                            '-'}
                          {' · '}开始 {formatRunStart(log)}
                          {' · '}尝试 {log.attempt ?? 1}
                          {' · '}
                          <span
                            className={cn(
                              log.notification_status === 'uncertain' &&
                                'text-warning',
                              (log.notification_status === 'failed' ||
                                log.notification_status === 'partial_failed') &&
                                'text-error',
                            )}
                            title={log.notification_error || ''}
                          >
                            通知 {notification}
                          </span>
                        </span>
                        {preview ? (
                          <span
                            className={cn(
                              'mt-0.5 block truncate',
                              log.error ? 'text-error' : 'text-foreground/80',
                            )}
                          >
                            {preview}
                          </span>
                        ) : ['queued', 'running', 'recovering'].includes(
                            log.status,
                          ) ? (
                          <span className="mt-0.5 block">
                            {log.status === 'queued'
                              ? '排队中...'
                              : '执行中...'}
                          </span>
                        ) : null}
                      </>
                    }
                    meta={live ? '-' : formatDuration(log.duration_ms)}
                  />
                );
              })}
            </ListGroup>
          )}
        </SettingsSection>
      </div>

      {editing && (
        <SheetFooter className="flex-row justify-end border-t border-surface-border pb-[max(1rem,env(safe-area-inset-bottom))]">
          <Button variant="outline" onClick={handleCancel} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </SheetFooter>
      )}

      <Dialog
        open={selectedLog !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedLog(null);
        }}
      >
        <DialogContent className="max-h-[90vh] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>定时任务完整结果</DialogTitle>
            <DialogDescription>
              {selectedLog
                ? `${formatDate(selectedLog.started_at ?? selectedLog.run_at)} · ${TRIGGER_LABEL[selectedLog.trigger_type || 'scheduled'] || selectedLog.trigger_type || '计划触发'}`
                : '查看本次定时任务的完整业务结果'}
            </DialogDescription>
            {selectedLog && (
              <div className="flex flex-wrap items-center gap-2 pt-1 text-caption text-muted-foreground">
                <RunLogStatusBadge status={selectedLog.status} />
                <span>耗时 {formatDuration(selectedLog.duration_ms)}</span>
                <span>
                  通知：
                  {NOTIFICATION_LABEL[
                    selectedLog.notification_status || 'skipped'
                  ] ||
                    selectedLog.notification_status ||
                    '无需通知'}
                </span>
                <span className="font-mono">Run {selectedLog.id}</span>
              </div>
            )}
          </DialogHeader>

          <div className="min-h-0 overflow-y-auto rounded-lg bg-muted/40 p-4 ring-1 ring-surface-border">
            {selectedLog?.error && (
              <div className="mb-4 rounded-lg bg-error/10 p-3 text-body text-error">
                <div className="mb-1 font-medium">执行错误</div>
                <div className="whitespace-pre-wrap break-words">
                  {selectedLog.error}
                </div>
              </div>
            )}
            {selectedLog?.result ? (
              <MarkdownRenderer
                content={selectedLog.result}
                groupJid={task.chat_jid}
                variant="docs"
              />
            ) : (
              <p className="text-body text-muted-foreground">
                本次运行没有留下可展示的业务结果。
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
